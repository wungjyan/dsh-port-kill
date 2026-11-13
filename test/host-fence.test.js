import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { apply, attributable } from '../host.js'

/**
 * Mount the plugin's routes on a throwaway HTTP server.
 *
 * `apply` is the plugin's real entry point, so registering through it exercises
 * the same handler wiring the Host uses — including the fence, which is the whole
 * point of testing over HTTP rather than calling the handler directly.
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>} the running server.
 */
async function mountRoutes() {
  const routes = new Map()

  const ctx = {
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler)
        return () => {}
      },
    },
    // No `connection` service: the fallback fence (loopback-only) is what gets
    // exercised, which is the stricter of the two paths.
    get: (name) => (name === 'tools' ? undefined : undefined),
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: { info: () => {}, warn: () => {} },
  }

  apply(ctx)

  const server = createServer((request, response) => {
    const path = String(request.url ?? '').split('?')[0]
    const handler = routes.get(path)
    if (handler === undefined) {
      response.writeHead(404)
      response.end('no route')
      return
    }
    handler(request, response)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

describe('HTTP fence', () => {
  test('admits a loopback GET on /ports', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/ports`)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(typeof body.currentUser, 'string')
      assert.ok(Array.isArray(body.items))
    } finally {
      await mounted.close()
    }
  })

  test('refuses a cross-site fetch', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/ports`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      assert.equal(response.status, 403)
    } finally {
      await mounted.close()
    }
  })

  test('refuses a foreign Origin', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/ports`, {
        headers: { origin: 'http://evil.example' },
      })
      assert.equal(response.status, 403)
    } finally {
      await mounted.close()
    }
  })

  test('admits an Origin that matches the Host', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/ports`, {
        headers: { origin: mounted.origin },
      })
      assert.equal(response.status, 200)
    } finally {
      await mounted.close()
    }
  })

  test('answers 405 for a method the route does not accept', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/ports`, { method: 'POST' })
      assert.equal(response.status, 405)
      assert.equal(response.headers.get('allow'), 'GET')
    } finally {
      await mounted.close()
    }
  })

  test('refuses a non-JSON body on /kill', async () => {
    // A cross-site HTML form cannot set this content type, so refusing it closes
    // the simplest drive-by path to a signal.
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/kill`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{"pid":1}',
      })
      assert.equal(response.status, 415)
    } finally {
      await mounted.close()
    }
  })

  test('rejects malformed JSON on /kill', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.code, 'invalid-json')
    } finally {
      await mounted.close()
    }
  })

  test('refuses to end this host process', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pid: process.pid,
          expectedPort: 1234,
          expectedStartedAtTs: 20200101000000,
          expectedProcessName: 'node',
          expectedUser: 'someone',
        }),
      })
      // The self check runs before the identity checks, so the refusal is a 403
      // even though every other field is also wrong.
      assert.equal(response.status, 403)
      const body = await response.json()
      assert.equal(body.code, 'refused-self')
    } finally {
      await mounted.close()
    }
  })

  test('rejects a non-integer pid', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 0, expectedPort: 80 }),
      })
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.equal(body.code, 'bad-request')
    } finally {
      await mounted.close()
    }
  })

  test('rejects a rebound probe with an invalid port', async () => {
    const mounted = await mountRoutes()
    try {
      const response = await fetch(`${mounted.origin}/port-kill/rebound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 0, previousPid: 1, previousProcessName: 'x' }),
      })
      assert.equal(response.status, 400)
    } finally {
      await mounted.close()
    }
  })
})

describe('which identity fields a platform can compare', () => {
  test('POSIX can compare both, so both comparisons run', () => {
    assert.deepEqual(attributable({ userAttribution: true, nameAttribution: true }), {
      user: true,
      name: true,
    })
  })

  test('Windows compares neither, because netstat reports neither', () => {
    // Running these anyway would not be "stricter": the live record has no user
    // and no name, so both comparisons would fail on an unchanged process and
    // every kill would be refused as if the list were stale.
    assert.deepEqual(attributable({ userAttribution: false, nameAttribution: false }), {
      user: false,
      name: false,
    })
  })

  test('a missing flag is treated as unsupported rather than assumed', () => {
    for (const capabilities of [{}, null, undefined, { userAttribution: 'yes' }]) {
      assert.deepEqual(attributable(capabilities), { user: false, name: false })
    }
  })
})
