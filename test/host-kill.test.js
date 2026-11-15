import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { loadBackend } from '../platforms/index.js'
import { listPorts, killProcess, checkPortRebound, scanPortsForPid } from '../host.js'

//
// What this platform can actually do, read before any test is registered: a
// comparison the platform cannot make is skipped on purpose, and the signal it
// reports follows the same declaration. That is not a weakened test — it is the
// same contract the plugin publishes to its users.
//
const capabilities = (await loadBackend())?.capabilities ?? {}

/**
 * Source of a tiny listener that owns the given ports until it is killed.
 *
 * Node rather than Python: the runtime running this suite is present on every
 * platform, and Windows has no `/usr/bin/python3`.
 * @param {readonly number[]} ports - the ports to bind on loopback.
 * @returns {string} a `-e` script body.
 */
function listenerSource(ports) {
  return [
    'const http = require("node:http")',
    `const ports = ${JSON.stringify(ports)}`,
    'let up = 0',
    'for (const port of ports) {',
    '  const server = http.createServer((request, response) => response.end("ok"))',
    '  server.listen(port, "127.0.0.1", () => { if (++up === ports.length) console.log(process.pid) })',
    '}',
  ].join('\n')
}

/**
 * Spawn a process that binds one port (or several) and sits there.
 *
 * The port is chosen from the ephemeral range and re-tried on collision, so
 * parallel test files do not fight over it.
 * @param {number | readonly number[]} ports - the port, or ports, to bind.
 * @returns {import('node:child_process').ChildProcess} the listener.
 */
function spawnListener(ports) {
  const list = Array.isArray(ports) ? ports : [ports]
  const child = spawn(process.execPath, ['-e', listenerSource(list)], {
    stdio: 'ignore',
    windowsHide: true,
  })
  spawned.push(child)
  return child
}

/**
 * Spawn a supervisor that restarts its listener whenever it dies.
 *
 * A shell loop was the original shape, but Windows has no `sh`. This is the same
 * behaviour in node, and it reports each child pid on stdout so the test can
 * stop a tree that Windows has no process groups for.
 * @param {number} port - the port the listener keeps re-taking.
 * @returns {{ child: import('node:child_process').ChildProcess, pids: number[] }} the supervisor and the children it reported.
 */
function spawnWatcher(port) {
  // Every generated statement ends with a semicolon: a line starting with `(`
  // after a line ending in `)` would be parsed as a call, which is a hazard no
  // reviewer of generated code sees coming.
  const source = [
    'const { spawn } = require("node:child_process");',
    `const childSource = ${JSON.stringify(listenerSource([port]))};`,
    'function start() {',
    '  const child = spawn(process.execPath, ["-e", childSource], { stdio: "ignore" });',
    '  console.log(child.pid);',
    '  child.on("exit", () => { setTimeout(start, 200); });',
    '}',
    'start();',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const pids = []
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isInteger(pid) && pid > 0 && !orphanPids.includes(pid)) {
        pids.push(pid)
        orphanPids.push(pid)
      }
    }
  })
  spawned.push(child)
  return { child, pids }
}

/**
 * Stop a supervisor and the listener it last started.
 * @param {{ child: import('node:child_process').ChildProcess, pids: number[] }} watcher - the handle from {@link spawnWatcher}.
 * @returns {void}
 */
function killWatcher(watcher) {
  try {
    watcher.child.kill('SIGKILL')
  } catch {
    // Already gone.
  }
  for (const pid of watcher.pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * Wait until a port shows up in a fresh scan.
 * @param {number} port - the port to wait for.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<object>} the row that appeared.
 */
// A scan on Windows costs about a second (netstat plus one PowerShell call), so
// the budget has to cover several of them before it gives up.
async function waitForPort(port, timeoutMs = 20_000) {
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

/** Listener pids a supervisor started, which no ChildProcess handle owns. */
const orphanPids = []

after(() => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
  for (const pid of orphanPids) {
    try {
      process.kill(pid, 'SIGKILL')
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

  test('refuses when the process name does not match', {
    // A platform that cannot read a name from the socket skips this comparison
    // by design; asserting it here would assert a capability it does not have.
    skip: capabilities.nameAttribution === true ? false : 'platform cannot attribute a socket name',
  }, async () => {
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

  test('refuses a process owned by another user', {
    // Same reason as the name comparison: netstat reports no socket owner.
    skip: capabilities.userAttribution === true ? false : 'platform cannot attribute a socket user',
  }, async () => {
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
    // Windows has no catchable signal: both buttons terminate outright and the
    // result says KILL. The platform declares which it is, so the test follows
    // that declaration instead of a POSIX assumption.
    assert.equal(result.signal, capabilities.gracefulSignal === true ? 'TERM' : 'KILL')
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
    // A supervisor that restarts its listener whenever it dies: the shape of
    // every dev-server watcher, and the case the rebound probe exists for.
    const watcher = spawnWatcher(PORT_B)

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
      killWatcher(watcher)
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
  return spawnListener([first, second])
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
