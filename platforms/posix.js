/**
 * The POSIX back end: macOS and Linux.
 *
 * Ports come from `lsof`, process detail from `ps`, working directories from a
 * second `lsof` call. This is the implementation the plugin originally shipped
 * as, moved behind the back-end interface so a Windows one can be added without
 * touching it.
 */
import { userInfo } from 'node:os'

import { resolveBinary, run } from './exec.js'
import {
  deriveProcessName,
  ipVersionOf,
  parseAddress,
  parseStartTime,
  parsePsLine,
} from './parse.js'

/**
 * Where `lsof` and `ps` live.
 *
 * An absolute path is preferred because a Finder- or Dock-launched app inherits
 * a minimal PATH, but the directory is not the same everywhere: macOS keeps
 * `lsof` in `/usr/sbin`, Ubuntu installs it into `/usr/bin`, and Homebrew puts it
 * under its own prefix. A single hardcoded path is therefore a claim about one
 * machine's layout, and the one it named was missing on Ubuntu — every scan
 * there failed with "lsof timed out", which pointed at the wrong problem.
 *
 * The bare name is the last resort: PATH is the OS's own answer, and if that
 * misses too, the caller gets an explicit "找不到可执行文件" instead of a hang.
 */
const LSOF_CANDIDATES = [
  '/usr/sbin/lsof',
  '/usr/bin/lsof',
  '/bin/lsof',
  '/usr/local/sbin/lsof',
  '/usr/local/bin/lsof',
  '/opt/homebrew/sbin/lsof',
  '/opt/homebrew/bin/lsof',
]
const PS_CANDIDATES = ['/bin/ps', '/usr/bin/ps', '/usr/local/bin/ps']

/** Resolved once: the answer cannot change while this process runs. */
let lsofBinary = null
let psBinary = null

function lsof() {
  if (lsofBinary === null) lsofBinary = resolveBinary(LSOF_CANDIDATES, 'lsof')
  return lsofBinary
}

function ps() {
  if (psBinary === null) psBinary = resolveBinary(PS_CANDIDATES, 'ps')
  return psBinary
}

/** Command ceilings. A scan that outlives these is treated as a failure, not a hang. */
const LSOF_TIMEOUT_MS = 5_000
const PS_TIMEOUT_MS = 3_000

/** `lsof` exits 1 to mean "nothing matched", which is a successful empty scan. */
const LSOF_EMPTY_EXIT = 1

/** Rendered by `lsof -F` for the two calls that need the field stream. */
const FIELDS_FULL = 'pcLnPTu'
const FIELDS_PID_ONLY = 'n'

/**
 * What this back end can do.
 *
 * macOS and Linux provide all of it, which is why this is the reference
 * implementation the other platforms are measured against.
 * @type {object}
 */
export const capabilities = {
  supported: true,
  gracefulSignal: true,
  canReadWorkingDirectory: true,
  userAttribution: true,
  nameAttribution: true,
  signalLabels: { soft: 'TERM', hard: 'KILL' },
}

/** Run `lsof`, treating its empty-result exit code as a successful scan. */
function runLsof(args) {
  return run(lsof(), args, { timeoutMs: LSOF_TIMEOUT_MS, emptyExitCode: LSOF_EMPTY_EXIT })
}

/**
 * Run `ps` with a forced C locale.
 *
 * `ps -o lstart` emits month and weekday names in the caller's language, so a
 * Chinese or German system would produce a start time this code cannot parse —
 * which would make the identity check unverifiable. `LC_ALL=C` pins it to
 * English, passed as the child's environment so concurrent scans cannot race.
 */
function runPs(args) {
  return run(ps(), args, { timeoutMs: PS_TIMEOUT_MS, env: { LC_ALL: 'C', LANG: 'C' } })
}

/**
 * Parse the `lsof -F pcLnPTu` field stream into raw listener records.
 *
 * Records are grouped by pid; a `p` line starts one, and each `n` line beneath
 * it is one bound address. Field order is not guaranteed across platforms, so
 * this reads by prefix rather than by position.
 * @param {string} stdout - the field stream.
 * @returns {Array<{ pid: number, processName: string, user: string, protocol: string, state: string, host: string, port: number, ipVersion: string }>} records.
 */
export function parseLsofStream(stdout) {
  const records = []
  const seen = new Set()

  let pid = null
  let processName = ''
  let user = ''
  let protocol = ''
  let state = ''

  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '') continue
    const key = rawLine[0]
    const value = rawLine.slice(1).trim()

    if (key === 'p') {
      const parsed = Number.parseInt(value, 10)
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null
      processName = ''
      user = ''
      protocol = ''
      state = ''
      continue
    }
    if (pid === null) continue

    if (key === 'c') {
      processName = value
      continue
    }
    if (key === 'L') {
      user = value
      continue
    }
    if (key === 'P') {
      protocol = value
      continue
    }
    if (key === 'T') {
      if (value.startsWith('ST=')) state = value.slice(3)
      continue
    }
    if (key !== 'n') continue

    const address = parseAddress(value)
    if (address === null) continue

    // The same socket is reported once per open fd, and a wildcard listener
    // repeats verbatim on a dual-stack machine. Both would otherwise add a row.
    const dedupe = `${String(pid)}|${address.host}|${String(address.port)}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)

    records.push({
      pid,
      processName,
      user,
      protocol: protocol === '' ? 'TCP' : protocol,
      state: state === '' ? 'LISTEN' : state,
      host: address.host,
      port: address.port,
      ipVersion: ipVersionOf(address.host),
    })
  }

  return records
}

/**
 * The logged-in user, without spawning `id -un`.
 * @returns {string} account name, or `unknown` when the platform cannot say.
 */
export function currentUser() {
  try {
    const name = userInfo().username
    if (typeof name === 'string' && name !== '') return name
  } catch {
    // Fall through to the environment.
  }
  const fromEnv =
    typeof process.env.USER === 'string'
      ? process.env.USER.trim()
      : typeof process.env.LOGNAME === 'string'
        ? process.env.LOGNAME.trim()
        : ''
  return fromEnv !== '' ? fromEnv : 'unknown'
}

/**
 * Scan every TCP LISTEN socket.
 * @returns {Promise<Array<object>>} raw records; empty when nothing is listening.
 */
export async function scanListeners() {
  const stdout = await runLsof(['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-F', FIELDS_FULL])
  return parseLsofStream(stdout)
}

/**
 * Scan every listener bound to one port.
 * @param {number} port - the port to inspect.
 * @returns {Promise<Array<object>>} raw records on that port.
 */
export async function scanPort(port) {
  const stdout = await runLsof([
    '-nP',
    '-a',
    `-iTCP:${String(port)}`,
    '-sTCP:LISTEN',
    '-F',
    FIELDS_FULL,
  ])
  return parseLsofStream(stdout)
}

/**
 * Scan every TCP port one pid is listening on.
 *
 * `-a` is required: without it `lsof -p X -iTCP` is the union of both filters and
 * would report every listener on the machine.
 * @param {number} pid - the process to inspect.
 * @returns {Promise<number[]>} its listening ports, ascending and distinct.
 */
export async function scanPortsForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return []

  let stdout
  try {
    stdout = await runLsof([
      '-nP',
      '-a',
      '-p',
      String(pid),
      '-iTCP',
      '-sTCP:LISTEN',
      '-F',
      FIELDS_PID_ONLY,
    ])
  } catch {
    // The advisory list is not worth failing a kill over; the identity check has
    // already read the port the caller cares about.
    return []
  }

  const ports = new Set()
  for (const line of stdout.split('\n')) {
    if (line[0] !== 'n') continue
    const address = parseAddress(line.slice(1).trim())
    if (address !== null) ports.add(address.port)
  }
  return [...ports].sort((left, right) => left - right)
}

/**
 * Batch-load command lines and start times for a set of pids in one `ps` call.
 * @param {readonly number[]} pids - the pids to describe.
 * @returns {Promise<Map<number, { command: string, startedAt: string | null, startedAtTs: number | null, startedEpochMs: number | null }>>} one entry per pid that `ps` could describe.
 */
export async function loadProcessInfo(pids) {
  const result = new Map()
  const unique = [...new Set(pids)]
  if (unique.length === 0) return result

  let stdout
  try {
    stdout = await runPs(['-ww', '-o', 'pid=,lstart=,command=', '-p', unique.join(',')])
  } catch {
    // Losing process detail costs the row its command and start time, but a
    // scan that could list the port is still worth returning.
    return result
  }

  for (const line of stdout.split('\n')) {
    const parsed = parsePsLine(line)
    if (parsed === null) continue

    const start = parseStartTime(parsed.startedAt)
    result.set(parsed.pid, {
      command: parsed.command,
      startedAt: parsed.startedAt,
      startedAtTs: start === null ? null : start.sortable,
      startedEpochMs: start === null ? null : start.epochMs,
    })
  }

  return result
}

/**
 * Batch-load working directories for a set of pids in one `lsof` call.
 * @param {readonly number[]} pids - the pids to describe.
 * @returns {Promise<Map<number, string>>} pid → directory, for the readable ones.
 */
export async function loadWorkingDirectories(pids) {
  const result = new Map()
  const unique = [...new Set(pids)]
  if (unique.length === 0) return result

  let stdout
  try {
    stdout = await runLsof(['-a', '-p', unique.join(','), '-d', 'cwd', '-Fpn'])
  } catch {
    return result
  }

  let pid = null
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    if (line[0] === 'p') {
      const parsed = Number.parseInt(line.slice(1).trim(), 10)
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null
      continue
    }
    if (line[0] !== 'n' || pid === null) continue
    const directory = line.slice(1).trim()
    if (directory !== '') result.set(pid, directory)
  }

  return result
}

/**
 * The pids of one process and its ancestors.
 * @param {number} pid - where to start walking.
 * @param {number} depth - how many levels to climb.
 * @returns {Promise<number[]>} the chain, starting at `pid`.
 */
export async function ancestorChain(pid, depth) {
  const chain = [pid]
  let cursor = pid
  for (let level = 0; level < depth; level += 1) {
    let stdout
    try {
      stdout = await runPs(['-o', 'ppid=', '-p', String(cursor)])
    } catch {
      break
    }
    const parent = Number.parseInt(stdout.trim(), 10)
    if (!Number.isInteger(parent) || parent <= 1) break
    chain.push(parent)
    cursor = parent
  }
  return chain
}

/** Re-exported so the shared layer has one place to reach the POSIX parsers. */
export { deriveProcessName, ipVersionOf, parseAddress, parseStartTime, parsePsLine }
