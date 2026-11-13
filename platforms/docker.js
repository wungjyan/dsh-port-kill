/**
 * Docker container attribution.
 *
 * ## The problem this solves
 *
 * `lsof` runs on the host, and a published container port is held by Docker's
 * own port-forwarding proxy — every published port shows up as the single
 * `com.docker.backend` (or `docker-proxy`) process. A row for :3306 therefore
 * names a proxy, not the MySQL container the user is actually looking for.
 *
 * Worse, that row's kill button is actively harmful: signalling the proxy does
 * not stop the container, it breaks forwarding for *every* port the proxy holds
 * and usually needs a Docker Desktop restart to recover. So attribution here is
 * not cosmetic — it is what lets the UI refuse that button.
 *
 * ## Why `docker ps` and not the API
 *
 * One call returns every container with its port bindings, its image and its
 * compose project, in about 30 ms. The HTTP API would need the socket path and a
 * version negotiation for no extra information.
 *
 * ## Everything here is best-effort
 *
 * Docker may be absent, the daemon may be stopped, or the user may lack
 * permission on the socket. All three are normal. A failed probe returns an empty
 * map so the port list still loads — attribution is an enhancement, never a
 * precondition for showing ports.
 */
import { execFile } from 'node:child_process'

/** Docker's own commands are on PATH; like `docker ps`, this is not privileged. */
const DOCKER_TIMEOUT_MS = 2_500

/** Suppress the progress banner so stderr stays empty on the happy path. */
const MAX_BUFFER = 1 << 20

/**
 * One published port as Docker reports it.
 *
 * @typedef {object} ContainerPort
 * @property {number} hostPort - the port on the host, which is what a row shows.
 * @property {number | null} containerPort - the port inside the container.
 * @property {string | null} hostIp - the bind address, or null for every interface.
 * @property {string} protocol - `tcp` or `udp`.
 */

/**
 * One container and the host ports it publishes.
 *
 * @typedef {object} ContainerInfo
 * @property {string} name - the container name.
 * @property {string} image - the image reference.
 * @property {string} project - the compose project, or an empty string.
 * @property {string} service - the compose service, or an empty string.
 * @property {ContainerPort[]} ports - the published ports.
 */

/**
 * Parse one `docker ps --format` line.
 *
 * The format string uses a tab separator and `.Ports` in Docker's own
 * `0.0.0.0:3306->3306/tcp, :::3306->3306/tcp` shape, so this splits on tabs and
 * then pulls every `->` pair out of the ports field.
 * @param {string} line - one output line, tab-separated.
 * @returns {ContainerInfo | null} the parsed container, or null when the line cannot be read.
 */
export function parseDockerLine(line) {
  const trimmed = line.replace(/\r$/, '')
  if (trimmed.trim() === '') return null

  const parts = trimmed.split('\t')
  if (parts.length < 3) return null

  const name = parts[0].trim()
  if (name === '') return null

  return {
    name,
    image: (parts[1] ?? '').trim(),
    ports: parsePortBindings(parts[2] ?? ''),
    project: (parts[3] ?? '').trim(),
    service: (parts[4] ?? '').trim(),
  }
}

/**
 * Extract every published port from Docker's `.Ports` field.
 *
 * Real shapes this must survive:
 * - `0.0.0.0:3306->3306/tcp, :::3306->3306/tcp` — dual-stack, one mapping twice
 * - `127.0.0.1:8080->80/tcp` — a specific bind address
 * - `0.0.0.0:32768->5432/tcp` — an ephemeral host port
 * - `80/tcp` — exposed but NOT published, so it holds no host port
 * - `0.0.0.0:5000-5001->5000-5001/tcp` — a range
 * @param {string} field - the raw `.Ports` value.
 * @returns {ContainerPort[]} one entry per distinct host port.
 */
export function parsePortBindings(field) {
  /** @type {ContainerPort[]} */
  const ports = []
  const seen = new Set()

  for (const chunk of field.split(',')) {
    const mapping = chunk.trim()
    if (mapping === '' || !mapping.includes('->')) continue

    const arrow = mapping.indexOf('->')
    const left = mapping.slice(0, arrow)
    const right = mapping.slice(arrow + 2)

    // The right half is `containerPort/proto`.
    const slash = right.indexOf('/')
    const containerText = slash === -1 ? right : right.slice(0, slash)
    const protocol = slash === -1 ? 'tcp' : right.slice(slash + 1).trim()

    // The left half is `host:port`; an IPv6 bind is `[::]:3306`, so the last
    // colon is the separator in both forms.
    const colon = left.lastIndexOf(':')
    const hostText = colon === -1 ? '' : left.slice(0, colon)
    const hostText2 = colon === -1 ? left : left.slice(colon + 1)

    const hostRange = expandRange(hostText2)
    const containerRange = expandRange(containerText)
    if (hostRange === null) continue

    for (let index = 0; index < hostRange.length; index += 1) {
      const hostPort = hostRange[index]
      // A range publishes several ports; pair each with its container peer when
      // the ranges line up, otherwise report the container port as unknown.
      const containerPort =
        containerRange !== null && containerRange.length === hostRange.length
          ? containerRange[index]
          : (containerRange?.[0] ?? null)

      const key = `${String(hostPort)}|${protocol}|${hostText}`
      if (seen.has(key)) continue
      seen.add(key)

      ports.push({
        hostPort,
        containerPort,
        hostIp: hostText === '' ? null : hostText,
        protocol,
      })
    }
  }

  return ports
}

/**
 * Expand `3306` or `5000-5001` into a list of port numbers.
 * @param {string} text - the port or range.
 * @returns {number[] | null} the ports, or null when the text is not a port.
 */
function expandRange(text) {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const dash = trimmed.indexOf('-')
  if (dash === -1) {
    const port = Number.parseInt(trimmed, 10)
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? [port] : null
  }

  const from = Number.parseInt(trimmed.slice(0, dash), 10)
  const to = Number.parseInt(trimmed.slice(dash + 1), 10)
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from <= 0 || to < from || to > 65_535) return null
  // A pathological range would allocate tens of thousands of entries.
  if (to - from > 1_024) return null

  const ports = []
  for (let port = from; port <= to; port += 1) ports.push(port)
  return ports
}

/**
 * Parse the whole `docker ps` output.
 * @param {string} stdout - the command output.
 * @returns {ContainerInfo[]} every readable container.
 */
export function parseDockerPs(stdout) {
  const containers = []
  for (const line of stdout.split('\n')) {
    const parsed = parseDockerLine(line)
    if (parsed !== null) containers.push(parsed)
  }
  return containers
}

/**
 * Build a host-port → container lookup from a container list.
 *
 * A port published by two containers is ambiguous, so the first one wins and the
 * caller still gets *a* name rather than a blank. Docker itself refuses to
 * publish the same host port twice, so this only happens with a stale listing.
 * @param {ContainerInfo[]} containers - the containers.
 * @returns {Map<number, { name: string, image: string, project: string, service: string, containerPort: number | null, protocol: string }>} the lookup.
 */
export function buildPortMap(containers) {
  /** @type {Map<number, object>} */
  const map = new Map()

  for (const container of containers) {
    for (const port of container.ports) {
      if (map.has(port.hostPort)) continue
      map.set(port.hostPort, {
        name: container.name,
        image: container.image,
        project: container.project,
        service: container.service,
        containerPort: port.containerPort,
        protocol: port.protocol,
      })
    }
  }

  return map
}

/** Name fragments Docker's proxy runs under, so a row can be recognised as one. */
const PROXY_NAMES = ['com.docker.backend', 'docker-proxy', 'vpnkit', 'com.docker.vpnkit']

/**
 * Whether a process name looks like Docker's port forwarding proxy.
 *
 * Attribution is keyed on the port, not the process, so this is only used to
 * decide whether a *missing* mapping still deserves an explanation: a row named
 * like a proxy with no container behind it is worth flagging, while an unrelated
 * process is not.
 * @param {string} processName - the row's process name.
 * @returns {boolean} true when the name is one of Docker's proxies.
 */
export function isDockerProxy(processName) {
  if (typeof processName !== 'string' || processName === '') return false
  const lower = processName.toLowerCase()
  return PROXY_NAMES.some((name) => lower.includes(name))
}

/**
 * List running containers and their published ports.
 *
 * Never throws: every failure mode (no docker, daemon down, permission denied)
 * is a normal state that should leave the port list working.
 * @returns {Promise<ContainerInfo[]>} the containers, or an empty list.
 */
export function listContainers() {
  return new Promise((resolve) => {
    execFile(
      'docker',
      [
        'ps',
        '--no-trunc',
        '--format',
        '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      { timeout: DOCKER_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          resolve([])
          return
        }
        resolve(parseDockerPs(String(stdout ?? '')))
      },
    )
  })
}

/**
 * The host-port → container lookup, or an empty map when Docker is unavailable.
 * @returns {Promise<Map<number, object>>} the lookup.
 */
export async function portToContainer() {
  return buildPortMap(await listContainers())
}

/**
 * Probe Docker once, reporting both availability and the port lookup.
 *
 * `available` answers a different question from "did any container match": a
 * machine without Docker and a machine whose containers publish none of these
 * ports both produce an empty map, but they need different explanations in the
 * UI. The distinction is whether the command could be run at all.
 * @returns {Promise<{ available: boolean, ports: Map<number, object> }>} the probe result.
 */
export function probeDocker() {
  return new Promise((resolve) => {
    execFile(
      'docker',
      [
        'ps',
        '--no-trunc',
        '--format',
        '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      { timeout: DOCKER_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        // Either the CLI is missing (ENOENT) or it ran and the daemon refused
        // (not running, permission denied, bad context). Both mean no container
        // can be named, so availability is false and the map is empty; the UI
        // says "Docker is unavailable" rather than implying there is no container.
        if (error !== null && error !== undefined) {
          resolve({ available: false, ports: new Map() })
          return
        }
        resolve({ available: true, ports: buildPortMap(parseDockerPs(String(stdout ?? ''))) })
      },
    )
  })
}
