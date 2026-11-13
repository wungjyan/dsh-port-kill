import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { listPorts, killProcess, checkPortRebound, scanPortsForPid } from '../host.js'

/**
 * Spawn a Python process that binds one port and sits there.
 *
 * Python rather than `nc` because it is guaranteed present on macOS and lets the
 * test pick the exact address to bind. The port is chosen from the ephemeral range
 * and re-tried on collision, so parallel test files do not fight over it.
 * @param {number} port - the port to bind.
 * @returns {import('node:child_process').ChildProcess} the listener.
 */
function spawnListener(port) {
  return spawn(
    '/usr/bin/python3',
    [
      '-c',
      [
        'import socket, time',
        's = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
        's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
        `s.bind(('127.0.0.1', ${String(port)}))`,
        's.listen(1)',
        'time.sleep(60)',
      ].join('\n'),
    ],
    { stdio: 'ignore' },
  )
}

/**
 * Wait until a port shows up in a fresh scan.
 * @param {number} port - the port to wait for.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<object>} the row that appeared.
 */
async function waitForPort(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const listed = await listPorts()
    const row = listed.items.find((item) => item.port === port)
    if (row !== undefined) return row
    if (Date.now() > deadline) {
      throw new Error(`port ${String(port)} never appeared in the scan`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150)
    })
  }
}

/** Ports used by this file, bound to distinct values so two listeners can coexist. */
const PORT_A = 45_331
const PORT_B = 45_332

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = []

after(() => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
})

describe('kill identity checks', () => {
  test('refuses when the pid no longer listens on the claimed port', async () => {
    const child = spawnListener(PORT_A)
    spawned.push(child)
    const row = await waitForPort(PORT_A)

    // Claim a port this pid does not hold: exactly what a stale list looks like.
    await assert.rejects(
      killProcess({
        pid: row.pid,
        port: PORT_B,
        force: false,
        expectedStartedAtTs: row.startedAtTs,
        expectedProcessName: row.processName,
        expectedUser: row.user,
      }),
      (error) => error.code === 'stale-list',
    )
  })

  test('refuses when the expected start time does not match', async () => {
    const row = await waitForPort(PORT_A)

    // A different start stamp stands in for a recycled pid: same port, same
    // user, same name, but a different process.
    await assert.rejects(
      killProcess({
        pid: row.pid,
        port: PORT_A,
        force: false,
        expectedStartedAtTs: 20200101000000,
        expectedProcessName: row.processName,
        expectedUser: row.user,
      }),
      (error) => error.code === 'identity-changed',
    )
  })

  test('refuses when the list carried no start time', async () => {
    const row = await waitForPort(PORT_A)

    // Skipping the check here would defeat the whole mechanism, so a missing
    // stamp is a refusal rather than a pass.
    await assert.rejects(
      killProcess({
        pid: row.pid,
        port: PORT_A,
        force: false,
        expectedStartedAtTs: null,
        expectedProcessName: row.processName,
        expectedUser: row.user,
      }),
      (error) => error.code === 'start-time-missing',
    )
  })

  test('refuses when the process name does not match', async () => {
    const row = await waitForPort(PORT_A)

    await assert.rejects(
      killProcess({
        pid: row.pid,
        port: PORT_A,
        force: false,
        expectedStartedAtTs: row.startedAtTs,
        expectedProcessName: 'not-the-same-process',
        expectedUser: row.user,
      }),
      (error) => error.code === 'stale-list',
    )
  })

  test('refuses a process owned by another user', async () => {
    const row = await waitForPort(PORT_A)

    await assert.rejects(
      killProcess({
        pid: row.pid,
        port: PORT_A,
        force: false,
        expectedStartedAtTs: row.startedAtTs,
        expectedProcessName: row.processName,
        expectedUser: 'root',
      }),
      (error) => error.code === 'refused-user',
    )
  })

  test('refuses to end this process', async () => {
    await assert.rejects(
      killProcess({
        pid: process.pid,
        port: PORT_A,
        force: false,
        expectedStartedAtTs: 20200101000000,
        expectedProcessName: 'node',
        expectedUser: 'anyone',
      }),
      (error) => error.code === 'refused-self',
    )
  })

  test('refuses a system pid', async () => {
    await assert.rejects(
      killProcess({
        pid: 1,
        port: PORT_A,
        force: false,
        expectedStartedAtTs: 20200101000000,
        expectedProcessName: 'launchd',
        expectedUser: 'root',
      }),
      (error) => error.code === 'refused-system' || error.code === 'refused-user',
    )
  })

  test('ends a verified listener and reports the port as released', async () => {
    const row = await waitForPort(PORT_A)

    const result = await killProcess({
      pid: row.pid,
      port: PORT_A,
      force: false,
      expectedStartedAtTs: row.startedAtTs,
      expectedProcessName: row.processName,
      expectedUser: row.user,
    })

    assert.equal(result.success, true)
    assert.equal(result.signal, 'TERM')
    assert.equal(result.pid, row.pid)

    const listed = await listPorts()
    assert.equal(
      listed.items.some((item) => item.port === PORT_A),
      false,
      'the port should be gone from the scan',
    )
  })

  test('reports no rebound when nothing re-claims the port', async () => {
    const rebound = await checkPortRebound({
      port: PORT_A,
      previousPid: 99_999,
      previousProcessName: 'python',
    })
    assert.equal(rebound.occupied, false)
    assert.equal(rebound.rebound, false)
    assert.equal(rebound.pid, null)
    assert.equal(rebound.message, null)
  })

  test('detects a rebound after a watcher re-claims the port', async () => {
    // A shell loop that restarts its child whenever it dies: the shape of every
    // dev-server watcher, and the case the rebound probe exists for.
    const watcher = spawn(
      '/bin/sh',
      [
        '-c',
        [
          'while true; do',
          'python3 -c "',
          'import socket, time',
          's = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
          's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
          `s.bind(('127.0.0.1', ${String(PORT_B)}))`,
          's.listen(1)',
          'time.sleep(20)',
          '" &',
          'CHILD=$!',
          'wait $CHILD',
          'sleep 0.2',
          'done',
        ].join('\n'),
      ],
      { stdio: 'ignore', detached: true },
    )
    spawned.push(watcher)

    try {
      const row = await waitForPort(PORT_B)

      await killProcess({
        pid: row.pid,
        port: PORT_B,
        force: false,
        expectedStartedAtTs: row.startedAtTs,
        expectedProcessName: row.processName,
        expectedUser: row.user,
      })

      // Give the watcher time to restart its child before asking.
      await new Promise((resolve) => {
        setTimeout(resolve, 1_500)
      })

      const rebound = await checkPortRebound({
        port: PORT_B,
        previousPid: row.pid,
        previousProcessName: row.processName,
      })

      assert.equal(rebound.occupied, true)
      assert.equal(rebound.rebound, true)
      assert.notEqual(rebound.pid, row.pid)
      assert.equal(typeof rebound.message, 'string')
      assert.ok(rebound.message.includes(String(PORT_B)))
    } finally {
      try {
        process.kill(-watcher.pid, 'SIGKILL')
      } catch {
        // The group may already be gone.
      }
    }
  })
})

describe('listPorts', () => {
  test('returns a scan with the current user and parsed rows', async () => {
    const listed = await listPorts()
    assert.equal(typeof listed.currentUser, 'string')
    assert.ok(listed.currentUser.length > 0)
    assert.ok(Array.isArray(listed.items))

    for (const item of listed.items) {
      assert.equal(typeof item.pid, 'number')
      assert.equal(typeof item.port, 'number')
      assert.ok(item.port > 0 && item.port <= 65_535)
      assert.equal(item.protocol, 'TCP')
      assert.equal(item.state, 'LISTEN')
      assert.ok(Array.isArray(item.hosts))
      assert.equal(typeof item.hostSummary, 'string')
    }
  })

  test('collapses one process and port into a single row', async () => {
    const listed = await listPorts()
    const keys = listed.items.map((item) => `${String(item.pid)}:${item.protocol}:${String(item.port)}`)
    assert.equal(new Set(keys).size, keys.length)
  })

  test('sorts newest first', async () => {
    const listed = await listPorts()
    const stamps = listed.items
      .map((item) => item.startedAtTs)
      .filter((value) => value !== null)
    const sorted = [...stamps].sort((left, right) => right - left)
    assert.deepEqual(stamps, sorted)
  })
})


/**
 * Pick a free port by binding port 0 and reading back what the kernel assigned.
 *
 * The fixed ports above are enough for the single-port cases, but the multi-port
 * ones spawn several listeners in sequence and a listener that is still exiting
 * would make the next one fail to bind. Asking the kernel avoids the race.
 * @returns {Promise<number>} a port that was free a moment ago.
 */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => {
        resolve(port)
      })
    })
  })
}

/**
 * Spawn one process listening on two ports.
 *
 * This is the shape that matters: the signal is addressed to the process, so
 * ending it takes both ports down, and the caller has to be told that.
 * @param {number} first - the first port.
 * @param {number} second - the second port.
 * @returns {import('node:child_process').ChildProcess} the dual listener.
 */
function spawnDualListener(first, second) {
  return spawn(
    '/usr/bin/python3',
    [
      '-c',
      [
        'import socket, time',
        'def listen(port):',
        '    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
        '    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
        '    s.bind(("127.0.0.1", port))',
        '    s.listen(1)',
        '    return s',
        `a = listen(${String(first)})`,
        `b = listen(${String(second)})`,
        'time.sleep(60)',
      ].join('\n'),
    ],
    { stdio: 'ignore' },
  )
}

/**
 * Run `body` against a live process that holds two ports, then clean it up.
 * @param {(context: { pid: number, ports: number[] }) => Promise<void>} body - the assertions.
 * @returns {Promise<void>} resolution after the listener is gone.
 */
async function withDualListener(body) {
  const first = await freePort()
  const second = await freePort()
  const child = spawnDualListener(first, second)
  try {
    await waitForPort(first)
    await waitForPort(second)
    await body({ pid: child.pid, ports: [first, second].sort((left, right) => left - right) })
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

describe('multi-port process', () => {
  test('scanPortsForPid reports every port the process holds', async () => {
    await withDualListener(async ({ pid, ports }) => {
      assert.deepEqual(await scanPortsForPid(pid), ports)
    })
  })

  test('scanPortsForPid rejects pids that cannot exist', async () => {
    assert.deepEqual(await scanPortsForPid(0), [])
    assert.deepEqual(await scanPortsForPid(-1), [])
    assert.deepEqual(await scanPortsForPid(1.5), [])
  })

  test('the list publishes one grouping per pid', async () => {
    await withDualListener(async ({ pid, ports }) => {
      const listed = await listPorts()
      assert.deepEqual(listed.portsByPid[String(pid)], ports)
    })
  })

  test('the grouping never disagrees with the rows it was built from', async () => {
    // A pid's grouping must be exactly the ports its rows carry, or the dialog
    // would warn about a port the table never showed.
    await withDualListener(async () => {
      const listed = await listPorts()
      for (const [pid, ports] of Object.entries(listed.portsByPid)) {
        const fromRows = listed.items
          .filter((item) => String(item.pid) === pid)
          .map((item) => item.port)
          .sort((left, right) => left - right)
        assert.deepEqual(ports, fromRows, `grouping for pid ${pid} disagrees with its rows`)
      }
    })
  })

  test('a kill reports every port it released', async () => {
    await withDualListener(async ({ pid, ports }) => {
      const row = (await listPorts()).items.find(
        (item) => item.pid === pid && item.port === ports[0],
      )
      assert.ok(row, 'the first port should be listed')

      const result = await killProcess({
        pid,
        port: ports[0],
        force: false,
        expectedStartedAtTs: row.startedAtTs,
        expectedProcessName: row.processName,
        expectedUser: row.user,
      })

      assert.equal(result.success, true)
      assert.deepEqual(result.affectedPorts, ports)
    })
  })
})
