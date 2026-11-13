/**
 * The Windows back end.
 *
 * ## Status: written from documentation, not yet verified on a real machine
 *
 * The parsers here are pure functions over documented command output and are
 * covered by unit tests using captured sample output. What is *not* verified is
 * that the commands are present and produce these exact shapes on a given
 * Windows install — that needs a real host.
 *
 * Until then the platform reports itself through {@link capabilities} so the UI
 * can state what it cannot do rather than silently returning blanks.
 *
 * ## Why the commands are these
 *
 * - `netstat -ano -p TCP` is present on every supported Windows version and
 *   prints the listening socket, its address and the owning pid. It is the only
 *   port source that needs no elevation for other users' sockets.
 * - `Get-CimInstance Win32_Process` supplies the name, command line, creation
 *   time and parent pid in one call for a batch of pids.
 * - `Get-NetTCPConnection` would be tidier but is absent on older builds and on
 *   Windows Server Core images that lack the NetTCPIP module.
 *
 * ## What Windows cannot do here
 *
 * - **No graceful signal.** `process.kill` on Windows terminates the process; a
 *   `SIGTERM` is not delivered as a catchable event. There is no TERM/KILL
 *   distinction to offer, so {@link capabilities.gracefulSignal} is false and the
 *   UI must not promise that work will be saved.
 * - **No working directory.** Reading another process's cwd needs handle
 *   inspection with debug privileges. Rows report `null` instead of a guess.
 * - **No socket owner.** `netstat` does not report it, and without elevation
 *   there is no way to ask. The row leaves the field empty rather than
 *   attributing every listener to the logged-in account, which would be a guess
 *   dressed as a fact. {@link capabilities.userAttribution} is false and identity
 *   verification skips the user comparison.
 * - **No socket name.** `netstat` reports a pid, not a name. The name in the list
 *   is derived from the command line, while a re-check can only read the image
 *   name; comparing a derived name against an image name would refuse kills for
 *   reasons that have nothing to do with the process changing, so
 *   {@link capabilities.nameAttribution} is false and the name comparison is
 *   skipped too. PID plus creation time still carry the identity check.
 */
import { userInfo } from 'node:os'

import { run } from './exec.js'
import { deriveProcessName, formatStartTime, ipVersionOf, parseAddress } from './parse.js'

/** `netstat` and PowerShell are both always on PATH; no absolute path needed. */
const NETSTAT = 'netstat'
const POWERSHELL = 'powershell.exe'

const NETSTAT_TIMEOUT_MS = 8_000
/**
 * Longer than the other ceilings on purpose: the first CIM query after boot can
 * take several seconds while the WMI service warms up, and a timeout here costs
 * every row its command line *and* its start time — which makes the identity
 * check refuse every kill on the first scan after a restart.
 */
const POWERSHELL_TIMEOUT_MS = 15_000
const SELF_CHAIN_DEPTH = 8

/**
 * What this back end can and cannot do, so callers never have to guess.
 *
 * The POSIX back end sets every flag to true. Reading these keeps the UI and the
 * identity check honest on a platform that lacks a capability, instead of
 * silently returning blanks or refusing every request.
 * @type {{ gracefulSignal: boolean, canReadWorkingDirectory: boolean, userAttribution: boolean, nameAttribution: boolean, signalLabels: { soft: string, hard: string } }}
 */
export const capabilities = {
  supported: true,
  gracefulSignal: false,
  canReadWorkingDirectory: false,
  userAttribution: false,
  nameAttribution: false,
  // Both buttons really do the same thing here; the labels say so.
  signalLabels: { soft: 'TERM', hard: 'KILL' },
}

/** Run `netstat`, which exits 0 even when nothing matches. */
function runNetstat(args) {
  return run(NETSTAT, args, { timeoutMs: NETSTAT_TIMEOUT_MS })
}

/**
 * Run a PowerShell script with a non-interactive profile.
 *
 * The encoding line is not decoration: when stdout is a pipe, Windows
 * PowerShell writes in the console code page, which is not UTF-8 on a Chinese or
 * Japanese install. Without it a command line containing a non-ASCII path comes
 * back as replacement characters and the row displays mojibake.
 * @param {string} script - the script body.
 * @returns {Promise<string>} its stdout.
 */
function runPowerShell(script) {
  return run(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`,
    ],
    { timeoutMs: POWERSHELL_TIMEOUT_MS },
  )
}

/**
 * Parse `netstat -ano` into listener records.
 *
 * Only `LISTENING` rows are kept: the same command prints established
 * connections, which are not ports anything is "occupied" by. Foreign addresses
 * are discarded — `0.0.0.0:0` is what a listener shows there.
 * @param {string} stdout - the command output.
 * @returns {Array<{ pid: number, port: number, host: string, protocol: string, state: string, ipVersion: string }>} one record per listening socket.
 */
export function parseNetstat(stdout) {
  const records = []
  const seen = new Set()

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    // Columns are whitespace-separated: Proto, Local, Foreign, State, PID.
    const parts = line.split(/\s+/)
    if (parts.length < 5) continue

    const [rawProto, local, , state, pidText] = parts
    // IPv6 sockets appear as a bracketed address in the same `TCP` column, but
    // some builds label them `TCPv6`; both are the TCP listeners this list is
    // about, so both are accepted and published under one protocol name.
    const proto = rawProto.toUpperCase()
    if (proto !== 'TCP' && proto !== 'TCPV6') continue
    if (state.toUpperCase() !== 'LISTENING') continue

    const pid = Number.parseInt(pidText, 10)
    if (!Number.isInteger(pid) || pid <= 0) continue

    const address = parseAddress(local)
    if (address === null) continue

    const dedupe = `${String(pid)}|${address.host}|${String(address.port)}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)

    records.push({
      pid,
      port: address.port,
      host: address.host,
      protocol: 'TCP',
      state: 'LISTEN',
      ipVersion: ipVersionOf(address.host),
    })
  }

  return records
}

/**
 * Parse the JSON one `Get-CimInstance Win32_Process | ConvertTo-Json` call emits.
 *
 * PowerShell emits a bare object rather than an array when exactly one process
 * matches, which would make a batch of one fail to iterate.
 * @param {string} stdout - the JSON text.
 * @returns {Map<number, { command: string, startedAt: string | null, startedAtTs: number | null, startedEpochMs: number | null, parentPid: number | null, name: string }>} one entry per pid.
 */
export function parseProcessJson(stdout) {
  const result = new Map()
  const text = stdout.trim()
  if (text === '') return result

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return result
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const pid = Number(row.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue

    const command = typeof row.CommandLine === 'string' ? row.CommandLine.trim() : ''
    const name = typeof row.Name === 'string' ? row.Name.trim() : ''

    // CIM serializes CreationDate as `/Date(1700000000000)/` on older builds and
    // as an ISO string on newer ones; both are accepted.
    const start = parseCimDate(row.CreationDate)

    result.set(pid, {
      command,
      name,
      startedAt: start === null ? null : start.text,
      startedAtTs: start === null ? null : start.sortable,
      startedEpochMs: start === null ? null : start.epochMs,
      parentPid: Number.isInteger(Number(row.ParentProcessId))
        ? Number(row.ParentProcessId)
        : null,
    })
  }

  return result
}

/**
 * Parse a CIM datetime into the same shapes the POSIX back end produces.
 * @param {unknown} value - the raw `CreationDate`.
 * @returns {{ text: string, sortable: number, epochMs: number } | null} the parsed value.
 */
export function parseCimDate(value) {
  if (value === null || value === undefined) return null

  let epochMs = Number.NaN

  if (typeof value === 'string') {
    // `ConvertTo-Json` on Windows PowerShell writes `/Date(ms)/`, and some
    // versions append the offset (`/Date(ms+0800)/`). The milliseconds are the
    // instant either way, so the suffix is ignored rather than rejected: a
    // rejected stamp would refuse every kill on that build.
    const wrapped = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value.trim())
    if (wrapped !== null) {
      epochMs = Number(wrapped[1])
    } else {
      // A trailing `Z` or offset keeps this unambiguous; a bare local stamp is
      // read as local time, matching how the process actually started.
      epochMs = Date.parse(value.trim())
    }
  } else if (typeof value === 'number') {
    epochMs = value
  } else if (typeof value === 'object' && value !== null && 'DateTime' in value) {
    // Win32_Process.CreationDate is sometimes projected as `{ DateTime: '...' }`.
    return parseCimDate(value.DateTime)
  }

  if (!Number.isFinite(epochMs)) return null

  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return null

  // Same `YYYYMMDDHHMMSS` shape the POSIX rows publish, so the contract holds
  // across platforms and the UI sorts both with one code path.
  const sortable =
    date.getFullYear() * 10_000_000_000 +
    (date.getMonth() + 1) * 100_000_000 +
    date.getDate() * 1_000_000 +
    date.getHours() * 10_000 +
    date.getMinutes() * 100 +
    date.getSeconds()

  return {
    // The same local-time string POSIX rows carry, so one column reads the same
    // on both platforms and the value is the clock time the process started at.
    text: formatStartTime(date),
    sortable,
    epochMs: date.getTime(),
  }
}

/**
 * The logged-in user.
 * @returns {string} the account name, or `unknown`.
 */
export function currentUser() {
  try {
    const name = userInfo().username
    if (typeof name === 'string' && name !== '') return name
  } catch {
    // Fall through.
  }
  const fromEnv = typeof process.env.USERNAME === 'string' ? process.env.USERNAME.trim() : ''
  return fromEnv !== '' ? fromEnv : 'unknown'
}

/**
 * Scan every TCP LISTEN socket.
 *
 * No `-p` protocol filter: `netstat` names IPv6 sockets `TCPv6` in that filter's
 * vocabulary, and whether `-p TCP` includes them depends on the build. Reading
 * the whole table and narrowing here costs a few hundred extra lines and cannot
 * silently lose every IPv6 listener.
 * @returns {Promise<Array<object>>} raw records.
 */
export async function scanListeners() {
  const stdout = await runNetstat(['-ano'])
  return parseNetstat(stdout)
}

/**
 * Scan every listener bound to one port.
 * @param {number} port - the port to inspect.
 * @returns {Promise<Array<object>>} raw records on that port.
 */
export async function scanPort(port) {
  // netstat has no per-port filter, so the full table is read and narrowed here.
  const records = await scanListeners()
  return records.filter((record) => record.port === port)
}

/**
 * Scan every TCP port one pid is listening on.
 * @param {number} pid - the process to inspect.
 * @returns {Promise<number[]>} its listening ports, ascending and distinct.
 */
export async function scanPortsForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return []
  try {
    const records = await scanListeners()
    const ports = new Set()
    for (const record of records) {
      if (record.pid === pid) ports.add(record.port)
    }
    return [...ports].sort((left, right) => left - right)
  } catch {
    return []
  }
}

/**
 * Build the WQL filter that selects a set of pids.
 *
 * WQL is a subset of SQL and has no `IN` operator: `ProcessId IN (1,2)` fails the
 * whole query, and a failed query costs every row its command, its name and its
 * start time — which in turn makes the identity check refuse every kill. Chained
 * `OR` equality is the form the provider accepts.
 * @param {readonly number[]} pids - the pids to select, already validated.
 * @returns {string} the filter text.
 */
export function processFilter(pids) {
  return pids.map((pid) => `ProcessId=${String(pid)}`).join(' OR ')
}

/**
 * Batch-load command lines, names and start times for a set of pids.
 * @param {readonly number[]} pids - the pids to describe.
 * @returns {Promise<Map<number, object>>} one entry per pid PowerShell returned.
 */
export async function loadProcessInfo(pids) {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
  if (unique.length === 0) return new Map()

  let stdout
  try {
    stdout = await runPowerShell(
      `Get-CimInstance Win32_Process -Filter "${processFilter(unique)}" ` +
        '| Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate ' +
        '| ConvertTo-Json -Compress',
    )
  } catch {
    // Losing process detail costs the row its command and start time, but a scan
    // that could list the port is still worth returning.
    return new Map()
  }

  const parsed = parseProcessJson(stdout)

  // `netstat` gives no process name, so it is filled in from here. `ps` does
  // this on POSIX; on Windows it is the only source.
  return parsed
}

/**
 * Working directories are not readable for other processes without debug
 * privileges, so this platform reports none rather than a guess.
 * @returns {Promise<Map<number, string>>} always empty.
 */
export async function loadWorkingDirectories() {
  return new Map()
}

/**
 * The pids of one process and its ancestors, from the CIM parent links.
 *
 * One call, not one per level: this runs while a kill is being verified, and
 * climbing eight generations one PowerShell start-up at a time would add seconds
 * to the click. The whole parent map is small and the walk is local.
 * @param {number} pid - where to start.
 * @param {number} depth - how many levels to climb.
 * @returns {Promise<number[]>} the chain, starting at `pid`.
 */
export async function ancestorChain(pid, depth) {
  const chain = [pid]

  let parents
  try {
    const stdout = await runPowerShell(
      'Get-CimInstance Win32_Process ' +
        '| Select-Object ProcessId,ParentProcessId ' +
        '| ConvertTo-Json -Compress',
    )
    parents = parseProcessJson(stdout)
  } catch {
    return chain
  }

  let cursor = pid
  for (let level = 0; level < depth; level += 1) {
    const parent = parents.get(cursor)?.parentPid
    if (!Number.isInteger(parent) || parent <= 1 || chain.includes(parent)) break
    chain.push(parent)
    cursor = parent
  }
  return chain
}

export { deriveProcessName, ipVersionOf, parseAddress, SELF_CHAIN_DEPTH }
