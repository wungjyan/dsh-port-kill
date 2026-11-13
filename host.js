/**
 * Port Kill — Host half.
 *
 * Lists the TCP sockets this machine is listening on, shows which process owns
 * each one, and ends that process only after re-verifying it is still the same
 * process the user saw. The browser cannot run `lsof` or send signals, so every
 * privileged operation lives here; the page only makes same-origin HTTP calls.
 *
 * ## Why the re-verification exists
 *
 * A kill is destructive and the list a user is looking at is always a little
 * stale. Between the scan and the click the process may have exited, and a
 * watcher or supervisor may have restarted it under a NEW process id that
 * happens to hold the SAME port — Vite, webpack and nodemon all do this. Killing
 * by (pid, port) alone would then end a process the user never saw.
 *
 * So the identity check compares four things, not two: pid, port, owning user,
 * process name, AND the process start time. The start time is what catches pid
 * reuse: a recycled pid will not share the original's start second.
 *
 * ## Node.js idioms, not translated Rust
 *
 * Port Kill was originally a Tauri app. Where Node has a direct equivalent the
 * child process is avoided entirely (`os.userInfo`, `process.kill(pid, 0)`,
 * `execFile`'s own `timeout`), and two Rust defects are corrected here:
 *
 *   - `ps -o lstart` is locale-sensitive. Under `zh_CN` it prints
 *     `四 11月/12 10:44:27 2026`, which the original's English month table could
 *     not parse — so its start-time comparison silently degraded to "skip the
 *     check". Every `ps` call here forces `LC_ALL=C`, and an unparseable start
 *     time REFUSES the kill instead of skipping the check.
 *   - `lsof -p X -iTCP` is an OR, not an AND. Every pid-filtered scan passes
 *     `-a`.
 *
 * ## Security
 *
 * `ctx.webServer` routes carry no authentication, Host check or Origin check of
 * their own — that fence belongs to the `/api` gateway, which these routes are
 * not part of. A bare `/kill` endpoint would therefore be triggerable by any web
 * page the user has open. Three things stand between the network and a signal:
 *
 *   1. {@link trustRequest} — the host's own `ctx.connection.requestRejection`
 *      gate (origin + browser login), falling back to loopback-only.
 *   2. POST + `content-type: application/json`, which a cross-site form cannot
 *      forge.
 *   3. The five-point identity check above, plus a refusal to signal this host
 *      process or any of its ancestors.
 */
import { loadBackend, UNSUPPORTED_CAPABILITIES } from './platforms/index.js'
import { isDockerProxy, probeDocker } from './platforms/docker.js'
import {
  SettingsRefusal,
  mergeSettings,
  navLabelLanguage,
  readSettings,
  settingsFile,
  writeSettings,
} from './settings.js'
import {
  deriveProcessName,
  ipVersionOf,
  parseAddress,
  parseStartTime,
  summarizeHosts,
} from './platforms/parse.js'

/** Services this plugin needs. `tools` is optional so a headless profile still loads. */
export const inject = ['webServer']

/** Route root. Every endpoint is an exact registration beneath it. */
const BASE = '/port-kill'

/** How long a TERM is given before the caller may escalate to KILL. */
const KILL_POLL_ATTEMPTS = 10
/** Progressive backoff: fast at first, slower once the process is clearly stubborn. */
const KILL_POLL_INTERVALS_MS = [50, 50, 50, 100, 100, 100, 200, 200, 200, 200]

/** How far up the parent chain the self-protection walks. */
const SELF_CHAIN_DEPTH = 8

/**
 * The selected platform back end.
 *
 * `apply()` is synchronous but loading a back end is not, so the promise is
 * started at mount and awaited by every entry point that needs it. A host with
 * no back end keeps this rejected, and every caller reports the platform as
 * unsupported rather than pretending the machine has no listeners.
 * @type {Promise<import('./platforms/index.js').PlatformBackend | null>}
 */
let backendPromise = null

/**
 * Resolve the back end, loading it once.
 * @returns {Promise<import('./platforms/index.js').PlatformBackend | null>} the back end, or null when unsupported.
 */
function backend() {
  if (backendPromise === null) backendPromise = loadBackend()
  return backendPromise
}

/**
 * The back end, or an error explaining that this platform has none.
 *
 * Returning an error instead of an empty list matters: an empty list would claim
 * "nothing is listening", which is a statement about a machine that was never
 * read. A 501 is the truthful answer.
 * @returns {Promise<import('./platforms/index.js').PlatformBackend>} the back end.
 * @throws {RequestError} 501 when the platform is unsupported.
 */
async function requireBackend() {
  const resolved = await backend()
  if (resolved === null) {
    throw new RequestError(501, 'unsupported-platform', UNSUPPORTED_CAPABILITIES.reason)
  }
  return resolved
}

/** Capability flags of the active platform; safe to read before the scan. */
let activeCapabilities = { ...UNSUPPORTED_CAPABILITIES }

/**
 * The capability flags of the platform this host is running on.
 * @returns {object} the flags, defaulting to "nothing works" until the back end loads.
 */
export function platformCapabilities() {
  return activeCapabilities
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Re-exported so the published contract survives the platform split. */
export { ipVersionOf, parseAddress, parseStartTime, deriveProcessName, summarizeHosts }

/** Also re-exported: they parse one platform's output but are pure functions. */
export { parseLsofStream, parsePsLine } from './platforms/posix.js'

/**
 * Every TCP port one process is listening on, live.
 *
 * A signal is addressed to a process, not to a socket, so ending a process that
 * holds several ports takes all of them down at once. The caller needs that list
 * to warn before the signal is sent rather than explain afterwards.
 * @param {number} pid - the process to inspect.
 * @returns {Promise<number[]>} its listening ports, ascending and distinct; empty when it holds none or the platform cannot say.
 */
export async function scanPortsForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return []
  const platform = await backend()
  if (platform === null) return []
  return platform.scanPortsForPid(pid)
}

/**
 * The logged-in user, from the active back end.
 * @returns {Promise<string>} account name, or `unknown` when the platform cannot say.
 */
async function currentUser() {
  const platform = await backend()
  return platform === null ? 'unknown' : platform.currentUser()
}

/**
 * Scan, aggregate and sort the port list.
 *
 * Records collapse on `pid:protocol:port`: one process listening on the same port
 * over both IPv4 and IPv6 is one row carrying two addresses, not two rows.
 * @returns {Promise<{ currentUser: string, items: Array<object>, portsByPid: Record<string, number[]>, scannedAt: number }>} the response body.
 */
export async function listPorts() {
  const startedAt = Date.now()
  const platform = await requireBackend()

  // The scan and the Docker probe are independent, so they start together. The
  // probe is needed before the flags can be published, hence the join here
  // rather than after the grouping.
  const [records, docker] = await Promise.all([platform.scanListeners(), probeDocker()])

  // Docker availability is a property of the machine, not of the platform back
  // end, so it is folded in where the probe result is known.
  const capabilities = { ...platform.capabilities, docker: docker.available }
  activeCapabilities = capabilities
  const containerPorts = docker.ports

  /** @type {Map<string, object>} */
  const grouped = new Map()

  for (const record of records) {
    const key = `${String(record.pid)}:${record.protocol}:${String(record.port)}`
    let item = grouped.get(key)
    if (item === undefined) {
      item = {
        pid: record.pid,
        processName: record.processName ?? '',
        user: record.user ?? '',
        protocol: record.protocol,
        port: record.port,
        state: record.state,
        hosts: [],
        hostSummary: '',
        ipVersions: [],
        command: '',
        cwd: null,
        startedAt: null,
        startedAtTs: null,
      }
      grouped.set(key, item)
    }
    if (!item.hosts.includes(record.host)) item.hosts.push(record.host)
    if (!item.ipVersions.includes(record.ipVersion)) item.ipVersions.push(record.ipVersion)
  }

  const pids = [...new Set([...grouped.values()].map((item) => item.pid))]
  const ownerName = await currentUser()
  // Docker and the process detail are independent, so they run together rather
  // than one after the other adding its latency to the scan.
  const [info, directories] = await Promise.all([
    platform.loadProcessInfo(pids),
    platform.loadWorkingDirectories(pids),
  ])

  for (const item of grouped.values()) {
    const detail = info.get(item.pid)
    item.hosts.sort()
    item.ipVersions.sort()
    item.hostSummary = summarizeHosts(item.hosts, item.ipVersions)

    // Windows reports no name from netstat, so the name is derived from the
    // command line there; POSIX already has one and keeps it.
    const fromPs = detail === undefined ? '' : detail.command
    item.command = fromPs === '' ? item.processName : fromPs
    if (item.processName === '') {
      item.processName = deriveProcessName(fromPs)
    }
    if (item.processName === '' && detail !== undefined && typeof detail.name === 'string') {
      item.processName = detail.name
    }
    if (item.processName === '') item.processName = '未知进程'
    // Only a platform that reports socket owners can fill this in. On one that
    // cannot, naming the logged-in account for every listener would present a
    // guess as a fact — and `netstat` lists other accounts' and system services'
    // ports too, so the guess would be wrong on exactly the rows that matter.
    if (item.user === '' && platform.capabilities.userAttribution === true) {
      item.user = ownerName
    }

    item.cwd = directories.get(item.pid) ?? null
    item.startedAt = detail === undefined ? null : detail.startedAt
    item.startedAtTs = detail === undefined ? null : detail.startedAtTs

    // A published container port is held by Docker's proxy on the host, so the
    // row names the proxy, not the container the user is looking for. The
    // container is reported alongside — never instead — because the proxy is
    // what a signal would actually reach.
    const container = containerPorts.get(item.port)
    item.container =
      container === undefined
        ? null
        : {
            name: container.name,
            image: container.image,
            project: container.project,
            service: container.service,
            containerPort: container.containerPort,
          }
    // Set when the process looks like a proxy but no container claims the port:
    // the port is Docker's, yet its owner cannot be named, so the UI must still
    // refuse to kill it without pretending to know what is behind it.
    item.dockerProxy = container === undefined && isDockerProxy(item.processName)
  }

  const items = [...grouped.values()].sort((left, right) => {
    // Newest first, then port, then name, then pid — the original's order.
    const leftTs = left.startedAtTs ?? -1
    const rightTs = right.startedAtTs ?? -1
    if (leftTs !== rightTs) return rightTs - leftTs
    if (left.port !== right.port) return left.port - right.port
    const byName = left.processName.localeCompare(right.processName)
    if (byName !== 0) return byName
    return left.pid - right.pid
  })

  // One process can hold many ports, and the signal takes them all. Publishing
  // the grouping with the list lets the confirmation dialog say so before the
  // user commits, instead of the toast explaining it afterwards.
  /** @type {Record<string, number[]>} */
  const portsByPid = {}
  for (const item of items) {
    const key = String(item.pid)
    const ports = portsByPid[key] ?? []
    if (!ports.includes(item.port)) ports.push(item.port)
    portsByPid[key] = ports
  }
  for (const ports of Object.values(portsByPid)) {
    ports.sort((left, right) => left - right)
  }

  return {
    currentUser: await currentUser(),
    items,
    portsByPid,
    capabilities,
    scannedAt: startedAt,
  }
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/** Cached ancestor chain of this host process; it cannot change while we run. */
let selfChainCache = null

/**
 * The pids of this host process and its ancestors.
 * @returns {Promise<Set<number>>} the chain, always containing our own pid.
 */
async function selfChain() {
  if (selfChainCache !== null) return selfChainCache

  const platform = await backend()
  const chain = new Set([process.pid])
  if (platform === null) {
    selfChainCache = chain
    return chain
  }

  let walked = []
  try {
    walked = await platform.ancestorChain(process.pid, SELF_CHAIN_DEPTH)
  } catch {
    walked = []
  }
  for (const pid of walked) {
    if (Number.isInteger(pid) && pid > 0) chain.add(pid)
  }

  selfChainCache = chain
  return chain
}

/**
 * Whether a process is still running.
 *
 * `EPERM` means the process exists but belongs to someone else, which is still
 * "alive" for the purpose of deciding whether a signal landed.
 * @param {number} pid - the process to probe.
 * @returns {boolean} true when it exists.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** An error carrying the HTTP status the route should answer with. */
class RequestError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
  }
}

/**
 * Which identity fields a platform can actually re-read for a live socket.
 *
 * A comparison against a field the platform never reports does not add safety —
 * it refuses every kill with "the process changed" when nothing changed. The
 * capability flags are the platform's own statement of what it can supply, so
 * they decide which comparisons are meaningful rather than which are convenient.
 * @param {object} capabilities - the platform's published flags.
 * @returns {{ user: boolean, name: boolean }} whether each comparison can run.
 */
export function attributable(capabilities) {
  const flags = capabilities !== null && typeof capabilities === 'object' ? capabilities : {}
  return {
    user: flags.userAttribution === true,
    name: flags.nameAttribution === true,
  }
}

/**
 * Confirm a pid is still the same listener the user saw.
 *
 * This is the safety core, and it is deliberately stricter than the scan that
 * produced the list: the scan groups by pid/port, this re-reads the live state
 * and compares every field the user was shown.
 * @param {{ pid: number, port: number, expectedStartedAtTs: number | null, expectedProcessName: string, expectedUser: string }} target - what the caller believes it is ending.
 * @returns {Promise<void>} resolution means the kill may proceed.
 * @throws {RequestError} describing exactly which check refused.
 */
async function verifyIdentity(target) {
  const { pid, port, expectedStartedAtTs, expectedProcessName, expectedUser } = target

  if (pid === process.pid || (await selfChain()).has(pid)) {
    throw new RequestError(
      403,
      'refused-self',
      pid === process.pid
        ? '不能结束 DSH 自身的进程'
        : '不能结束 DSH 宿主所在进程链上的进程（结束了当前界面也会一起退出）',
    )
  }

  if (pid <= 1) {
    throw new RequestError(403, 'refused-system', '不能结束系统进程')
  }

  // Loaded before the comparisons because what can be compared depends on it.
  const platform = await requireBackend()
  const can = attributable(platform.capabilities)

  const me = await currentUser()
  if (can.user && expectedUser !== me) {
    throw new RequestError(
      403,
      'refused-user',
      `没有权限结束用户"${expectedUser}"的进程，请仅操作当前用户"${me}"的进程`,
    )
  }

  // Re-read this port's live listeners rather than trusting the caller's row.
  let listeners
  try {
    listeners = await platform.scanPort(port)
  } catch (error) {
    throw new RequestError(
      500,
      'rescan-failed',
      `无法复核端口 ${String(port)}：${error.message}`,
    )
  }

  const current = listeners.find((record) => record.pid === pid)
  if (current === undefined) {
    throw new RequestError(
      409,
      'stale-list',
      `进程身份已变化：PID ${String(pid)} 已不再监听端口 ${String(port)}，请刷新列表后重试`,
    )
  }

  if (can.user && current.user !== expectedUser) {
    throw new RequestError(
      409,
      'stale-list',
      `进程身份已变化：端口 ${String(port)} 的监听进程与列表记录不一致，请刷新后重试`,
    )
  }

  if (can.name && !processNameMatches(current.processName, expectedProcessName)) {
    throw new RequestError(
      409,
      'stale-list',
      `进程身份已变化：端口 ${String(port)} 的监听进程与列表记录不一致，请刷新后重试`,
    )
  }

  // Start time is the only field that distinguishes a recycled pid from the
  // original, so a missing or unparseable stamp REFUSES rather than skips.
  const info = (await platform.loadProcessInfo([pid])).get(pid)
  const liveStartedAtTs = info === undefined ? null : info.startedAtTs
  if (liveStartedAtTs === null) {
    throw new RequestError(
      409,
      'start-time-unavailable',
      `无法确认进程 ${String(pid)} 的启动时间，为避免误杀已取消操作，请刷新列表后重试`,
    )
  }
  if (expectedStartedAtTs === null) {
    throw new RequestError(
      409,
      'start-time-missing',
      `列表中的进程 ${String(pid)} 缺少启动时间，无法确认身份，请刷新列表后重试`,
    )
  }
  if (liveStartedAtTs !== expectedStartedAtTs) {
    throw new RequestError(
      409,
      'identity-changed',
      `进程身份已变化：PID ${String(pid)} 的启动时间与列表记录不一致，请刷新后重试`,
    )
  }
}

/**
 * Compare two process names the way the list presents them.
 * @param {string} current - the live name.
 * @param {string} expected - the name the user saw.
 * @returns {boolean} true when they name the same process.
 */
function processNameMatches(current, expected) {
  const left = String(current ?? '').trim()
  const right = String(expected ?? '').trim()
  if (left === '' || right === '') return false
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Sleep for a short interval.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolution after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * End one process after re-verifying its identity.
 * @param {object} target - the kill request, see {@link verifyIdentity}.
 * @returns {Promise<{ pid: number, signal: string, success: boolean, message: string, affectedPorts: number[] }>} the outcome.
 * @throws {RequestError} when a check refuses or the signal does not take.
 */
export async function killProcess(target) {
  const { pid, force } = target

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new RequestError(400, 'bad-request', '无效的 PID')
  }
  if (!Number.isInteger(target.port) || target.port <= 0) {
    throw new RequestError(400, 'bad-request', '无效的端口')
  }

  await verifyIdentity(target)

  if (!isAlive(pid)) {
    throw new RequestError(409, 'already-gone', `进程 ${String(pid)} 已退出`)
  }

  // Read the ports this process holds *before* signalling it — afterwards there
  // is nothing left to read, and the caller needs the list to say what was lost.
  // The requested port is folded in even if the scan comes up empty: the caller
  // is ending it, so it is affected by definition.
  const platform = await requireBackend()
  const scanned = await platform.scanPortsForPid(pid)
  const affectedPorts =
    scanned.includes(target.port)
      ? scanned
      : [...scanned, target.port].sort((left, right) => left - right)

  // On a platform without a catchable signal, "soft" and "hard" are the same
  // operation — process.kill terminates either way. Reporting the request as
  // TERM would claim the process had a chance to save its work when it did not.
  const graceful = platform.capabilities.gracefulSignal === true
  const signal = force === true || !graceful ? 'SIGKILL' : 'SIGTERM'

  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error.code === 'EPERM') {
      throw new RequestError(
        403,
        'refused-permission',
        `没有权限结束进程 ${String(pid)}，请检查进程所属用户或系统权限`,
      )
    }
    if (error.code === 'ESRCH') {
      throw new RequestError(409, 'already-gone', `进程 ${String(pid)} 已退出`)
    }
    throw new RequestError(
      500,
      'kill-failed',
      `结束进程 ${String(pid)} 失败：${String(error.message)}`,
    )
  }

  for (const delayMs of KILL_POLL_INTERVALS_MS) {
    await sleep(delayMs)
    if (!isAlive(pid)) {
      return {
        pid,
        signal: signal === 'SIGKILL' ? 'KILL' : 'TERM',
        success: true,
        message: graceful ? '已结束' : '进程已强制结束（该平台没有可捕获的退出信号）',
        affectedPorts,
      }
    }
  }

  throw new RequestError(
    409,
    'still-alive',
    force === true
      ? `进程 ${String(pid)} 在强制结束后仍未退出`
      : `进程 ${String(pid)} 未响应结束信号，请尝试强制结束`,
  )
}

/**
 * Report whether a port has been re-claimed after a kill.
 *
 * Watchers and service managers restart what they supervise, so a port that
 * reappears under a new pid is the expected outcome rather than an error — the
 * user needs to be told which pid holds it now.
 * @param {{ port: number, previousPid: number, previousProcessName: string }} request - what was just killed.
 * @returns {Promise<object>} the rebound report.
 */
export async function checkPortRebound(request) {
  const { port, previousPid, previousProcessName } = request

  if (!Number.isInteger(port) || port <= 0) {
    throw new RequestError(400, 'bad-request', '无效的端口')
  }

  const platform = await requireBackend()
  const records = await platform.scanPort(port)
  if (records.length === 0) {
    return {
      port,
      occupied: false,
      rebound: false,
      sameProcessName: false,
      pid: null,
      processName: null,
      command: null,
      message: null,
    }
  }

  records.sort((left, right) => left.pid - right.pid)

  // Prefer a differently-named successor, then any new pid, then the original —
  // the same preference order the original app used, so the message names the
  // process that most likely took over.
  const successor =
    records.find(
      (record) =>
        record.pid !== previousPid &&
        processNameMatches(record.processName, previousProcessName),
    ) ??
    records.find((record) => record.pid !== previousPid) ??
    records[0]

  const info = (await platform.loadProcessInfo([successor.pid])).get(successor.pid)
  const processName =
    successor.processName !== '' ? successor.processName : deriveProcessName(info?.command ?? '')
  const sameProcessName = processNameMatches(processName, previousProcessName)
  const rebound = successor.pid !== previousPid

  return {
    port,
    occupied: true,
    rebound,
    sameProcessName,
    pid: successor.pid,
    processName: processName === '' ? null : processName,
    command: info === undefined || info.command === '' ? null : info.command,
    message: sameProcessName
      ? `端口 ${String(port)} 已被重新监听，当前仍是"${processName}"（PID ${String(successor.pid)}），可能由后台服务自动拉起`
      : `端口 ${String(port)} 已被重新占用，当前进程为"${processName}"（PID ${String(successor.pid)}）`,
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Match one row against a free-text query.
 *
 * The same fields the search box matches, so the tool and the UI agree on what
 * a query means.
 * @param {object} item - one aggregated row.
 * @param {string} query - lower-cased free text.
 * @returns {boolean} true when the row matches.
 */
export function matchesQuery(item, query) {
  return [item.processName, item.command, item.cwd ?? '', String(item.port), String(item.pid)]
    .join(' ')
    .concat(' ', item.hosts.join(' '))
    .toLowerCase()
    .includes(query)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - body to serialize.
 */
function sendJson(response, status, payload) {
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Decide whether a request may reach a privileged route.
 *
 * Prefers the host's own gate, which applies exactly the checks `/api` applies —
 * origin, browser login, and declared non-loopback authorities. When the host
 * predates that service the fallback is the strictest possible reading: loopback
 * peer, no cross-site fetch metadata, and an Origin that matches Host if present.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {object} ctx - Host context, for `ctx.connection`.
 * @returns {number | undefined} rejection status, or undefined when admitted.
 */
function requestRejection(request, ctx) {
  const connection = ctx.get('connection')
  const gate = connection === undefined ? undefined : connection.requestRejection
  if (typeof gate === 'function') {
    return gate.call(connection, request)
  }

  const deny = 403

  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return deny

  const origin = request.headers.origin
  if (origin !== undefined) {
    const host = request.headers.host
    if (host === undefined) return deny
    try {
      if (new URL(origin).host !== host) return deny
    } catch {
      return deny
    }
  }

  const remote = request.socket.remoteAddress
  const loopback =
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1'
  return loopback ? undefined : deny
}

/**
 * Read a small JSON request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {number} [limit] - maximum accepted bytes.
 * @returns {Promise<unknown>} the parsed body.
 * @throws {RequestError} on an oversized, non-JSON or malformed body.
 */
function readJsonBody(request, limit = 8_192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new RequestError(413, 'body-too-large', '请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new RequestError(400, 'invalid-json', '请求体不是合法的 JSON'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Require a mutating request to be JSON, which a cross-site form cannot produce.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @throws {RequestError} when the content type is wrong.
 */
function requireJsonContentType(request) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase()
  if (!type.includes('application/json')) {
    throw new RequestError(415, 'unsupported-media-type', '请求必须使用 application/json')
  }
}

/**
 * Wrap a handler with method dispatch, the trust fence and error normalization.
 * @param {object} ctx - Host context.
 * @param {{ methods: string[], json?: boolean }} policy - accepted methods and whether a body is required.
 * @param {(request: import('node:http').IncomingMessage) => Promise<{ status?: number, body: unknown }>} handler - the route body.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} a node:http handler.
 */
function route(ctx, policy, handler) {
  return (request, response) => {
    void (async () => {
      const rejection = requestRejection(request, ctx)
      if (rejection !== undefined) {
        sendJson(response, rejection, {
          ok: false,
          code: 'untrusted',
          message: '这个请求来自不受信任的来源，已拒绝',
        })
        return
      }

      const method = String(request.method ?? 'GET').toUpperCase()
      if (!policy.methods.includes(method)) {
        response.setHeader('allow', policy.methods.join(', '))
        sendJson(response, 405, {
          ok: false,
          code: 'method-not-allowed',
          message: `只接受 ${policy.methods.join(' / ')}`,
        })
        return
      }

      if (policy.json === true) requireJsonContentType(request)

      const result = await handler(request)
      sendJson(response, result.status ?? 200, result.body)
    })().catch((error) => {
      if (error instanceof RequestError) {
        sendJson(response, error.status, {
          ok: false,
          code: error.code,
          message: error.message,
        })
        return
      }
      ctx.logger?.warn?.(`[port-kill] route failure: ${String(error?.message ?? error)}`)
      sendJson(response, 500, {
        ok: false,
        code: 'internal',
        message: String(error?.message ?? error),
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

/**
 * Render a compact table of rows for a tool result.
 * @param {Array<object>} items - rows to render.
 * @returns {string} the text body.
 */
function renderPortTable(items) {
  if (items.length === 0) return '没有匹配的监听端口。'

  const lines = items.map((item) => {
    const started = item.startedAt === null ? '未知' : item.startedAt
    return [
      `:${String(item.port)}`.padEnd(8),
      `${item.processName} (PID ${String(item.pid)})`.padEnd(28),
      item.user.padEnd(12),
      item.hostSummary,
      `启动 ${started}`,
      item.command === item.processName ? '' : `命令 ${item.command}`,
      item.cwd === null ? '' : `目录 ${item.cwd}`,
    ]
      .filter((part) => part !== '')
      .join('  ')
  })

  return `${String(items.length)} 个监听端口\n\n${lines.join('\n')}`
}

/**
 * Register the two agent tools.
 *
 * Definitions are plain objects rather than `defineTool()` calls: this package
 * must not depend on a build-time import that resolves only by accident from the
 * profile's ancestor directories. `tools.register` validates the same shape.
 * @param {object} ctx - Host context.
 * @returns {() => void} disposer removing both tools.
 */
function registerTools(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    // A headless profile has no tool registry; the HTTP routes still work.
    return () => {}
  }

  const listDisposer = tools.register({
    name: 'port_list',
    description:
      '列出本机正在监听的 TCP 端口及其占用进程（进程名、PID、所属用户、监听地址、命令行、工作目录、启动时间）。可按关键词过滤。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: '可选关键词，匹配端口、PID、进程名、命令行、工作目录与监听地址。',
        },
        limit: {
          type: 'integer',
          description: '最多返回多少行，默认 50，上限 200。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'items'],
        properties: {
          total: { type: 'integer', description: '匹配的端口数量。' },
          currentUser: { type: 'string', description: '运行 DSH 的当前用户。' },
          capabilities: {
            type: 'object',
            additionalProperties: true,
            description:
              '当前平台的能力标志：gracefulSignal 表示能否优雅结束进程，userAttribution 表示能否识别套接字所属用户，nameAttribution 表示能否从套接字读到进程名，canReadWorkingDirectory 表示能否读到工作目录。为 false 的项在该平台上显示为空或不可用，不要当作"没有"。',
            properties: {},
          },
          items: {
            type: 'array',
            description: '端口记录。',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {},
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: renderPortTable(Array.isArray(value.items) ? value.items : []) },
      ],
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      const rawLimit = typeof args?.limit === 'number' ? Math.trunc(args.limit) : 50
      const limit = Math.min(Math.max(rawLimit, 1), 200)

      const listed = await listPorts()
      const matched = query === '' ? listed.items : listed.items.filter((item) => matchesQuery(item, query))

      return {
        total: matched.length,
        currentUser: listed.currentUser,
        capabilities: listed.capabilities,
        items: matched.slice(0, limit),
      }
    },
  })

  const killDisposer = tools.register({
    name: 'port_kill',
    description:
      '结束占用某个监听端口的进程。会先重新扫描该端口，复核 PID、所属用户、进程名与启动时间，任一项不符即拒绝，避免误杀已被复用的 PID。必须显式传 confirm: true 才会执行。注意：信号是按进程投递的，如果一个进程同时监听多个端口（例如微信、IDE 各占多个），结束它会把这些端口一起释放；返回值里的 affectedPorts 就是受影响的全部端口。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pid', 'port', 'confirm'],
      properties: {
        pid: { type: 'integer', description: '要结束的进程 PID。' },
        port: { type: 'integer', description: '该进程正在监听的端口，用于复核身份。' },
        force: {
          type: 'boolean',
          description: 'true 时直接发送 SIGKILL；省略或 false 时先发 SIGTERM。',
        },
        confirm: {
          type: 'boolean',
          description: '必须为 true，表示确认执行结束操作。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'signal', 'success', 'message', 'affectedPorts'],
        properties: {
          pid: { type: 'integer' },
          signal: { type: 'string' },
          success: { type: 'boolean' },
          message: { type: 'string' },
          affectedPorts: {
            type: 'array',
            description:
              '被这次结束一并带下的全部监听端口。一个进程可以同时监听多个端口，信号是按进程投递的。',
            items: { type: 'integer' },
          },
          rebound: {
            type: 'object',
            additionalProperties: true,
            description: '结束后该端口是否被新的进程重新占用。',
            properties: {},
          },
        },
      },
      render: (_args, value) => {
        const ports = Array.isArray(value.affectedPorts) ? value.affectedPorts : []
        const portNote =
          ports.length > 1
            ? `该进程同时监听 ${String(ports.length)} 个端口（${ports.join('、')}），已一并释放。`
            : ''
        const rebound = value.rebound
        const extra =
          rebound !== undefined && rebound !== null && rebound.occupied === true
            ? `\n${String(rebound.message ?? '')}`
            : ''
        return [
          {
            type: 'text',
            text: `进程 ${String(value.pid)} 已用 ${String(value.signal)} 结束（${String(value.message)}）。${portNote}${extra}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      if (args?.confirm !== true) {
        throw new Error(
          'port_kill 需要显式传入 confirm: true。请先确认目标进程确实是要结束的那个。',
        )
      }

      const pid = args.pid
      const port = args.port

      // The tool must not trust the model's claims any more than the UI trusts
      // a stale row: read the live row and use ITS identity as the expectation.
      const live = (await listPorts()).items.find(
        (item) => item.pid === pid && item.port === port,
      )
      if (live === undefined) {
        throw new Error(
          `PID ${String(pid)} 当前没有监听端口 ${String(port)}。先调用 port_list 确认目标。`,
        )
      }

      const result = await killProcess({
        pid,
        port,
        force: args.force === true,
        expectedStartedAtTs: live.startedAtTs,
        expectedProcessName: live.processName,
        expectedUser: live.user,
      })

      // Watchers restart what they supervise; the caller should know that the
      // port came back rather than assume the kill failed.
      let rebound
      try {
        await sleep(900)
        rebound = await checkPortRebound({
          port,
          previousPid: pid,
          previousProcessName: live.processName,
        })
      } catch {
        rebound = undefined
      }

      void exec
      return { ...result, rebound }
    },
  })

  return () => {
    killDisposer()
    listDisposer()
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register the routes and tools.
 * @param {object} ctx - Host Cordis context.
 */
export function apply(ctx) {
  const onList = route(ctx, { methods: ['GET'] }, async () => ({
    body: await listPorts(),
  }))

  const onKill = route(ctx, { methods: ['POST'], json: true }, async (request) => {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new RequestError(400, 'invalid-shape', '请求体必须是一个 JSON 对象')
    }
    const result = await killProcess({
      pid: body.pid,
      port: body.expectedPort,
      force: body.force === true,
      expectedStartedAtTs: body.expectedStartedAtTs ?? null,
      expectedProcessName: body.expectedProcessName,
      expectedUser: body.expectedUser,
    })
    return { body: result }
  })

  const onRebound = route(ctx, { methods: ['POST'], json: true }, async (request) => {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new RequestError(400, 'invalid-shape', '请求体必须是一个 JSON 对象')
    }
    return {
      body: await checkPortRebound({
        port: body.port,
        previousPid: body.previousPid,
        previousProcessName: body.previousProcessName,
      }),
    }
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${BASE}/ports`, handler: onList }),
    'port-kill: list route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${BASE}/kill`, handler: onKill }),
    'port-kill: kill route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${BASE}/rebound`, handler: onRebound }),
    'port-kill: rebound route',
  )

  // A repaired value is otherwise invisible: the request succeeds, the form
  // draws the default, and nothing says why. One warning per read diagnoses it.
  const reportRepair = (fields) => {
    ctx.logger?.warn?.(
      `[port-kill] ${settingsFile()} held values this build cannot use; ${fields.join(', ')} fell back to the defaults, everything else was kept`,
    )
  }

  const onSettings = route(ctx, { methods: ['GET', 'POST'], json: false }, async (request) => {
    if (String(request.method ?? 'GET').toUpperCase() === 'GET') {
      const settings = await readSettings(reportRepair)
      return { body: { ok: true, settings } }
    }

    // A cross-site form cannot set this header, so requiring it keeps the write
    // path closed to a forged POST from another origin.
    requireJsonContentType(request)

    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new RequestError(400, 'invalid-shape', '请求体必须是一个 JSON 对象')
    }

    const current = await readSettings(reportRepair)
    let next
    try {
      next = mergeSettings(current, body)
    } catch (error) {
      if (error instanceof SettingsRefusal) {
        throw new RequestError(error.status, error.code, error.message)
      }
      throw error
    }

    await writeSettings(next)
    ctx.logger?.info?.(
      `[port-kill] settings saved: refreshMs=${String(next.refreshMs)} navLabel=${next.navLabel}`,
    )
    return { body: { ok: true, settings: next } }
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${BASE}/settings`, handler: onSettings }),
    'port-kill: settings route',
  )

  ctx.effect(() => registerTools(ctx), 'port-kill: agent tools')

  ctx.logger?.info?.(`[port-kill] mounted at ${BASE} (ports, kill, rebound)`)
}
