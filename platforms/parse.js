/**
 * Parsers shared by every platform back end.
 *
 * These are pure functions over command output, so they carry no platform
 * dependency themselves and both a POSIX and a Windows back end can use them.
 * Keeping them here means adding a platform never means copying a parser.
 */

/** Month names as `ps` prints them under `LC_ALL=C`, zero-based like `Date`. */
const MONTHS = new Map([
  ['Jan', 0],
  ['Feb', 1],
  ['Mar', 2],
  ['Apr', 3],
  ['May', 4],
  ['Jun', 5],
  ['Jul', 6],
  ['Aug', 7],
  ['Sep', 8],
  ['Oct', 9],
  ['Nov', 10],
  ['Dec', 11],
])

/**
 * Whether a bind address is IPv6.
 * @param {string} host - the host part, e.g. `127.0.0.1`, `*`, `[::1]`.
 * @returns {'IPv4' | 'IPv6'} the family.
 */
export function ipVersionOf(host) {
  if (host === '*') return 'IPv4'
  return host.includes(':') ? 'IPv6' : 'IPv4'
}

/**
 * Split one `lsof -n` address into its host and port.
 *
 * Handles `*:5173`, `127.0.0.1:8080`, `[::1]:3000`, and the `local->remote` form
 * a connected socket carries (only the local half matters for a listener).
 * @param {string} value - the address lsof printed.
 * @returns {{ host: string, port: number } | null} the parts, or null.
 */
export function parseAddress(value) {
  const local = value.includes('->') ? value.slice(0, value.indexOf('->')) : value
  const colon = local.lastIndexOf(':')
  if (colon === -1) return null
  const port = Number.parseInt(local.slice(colon + 1), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null
  return { host: local.slice(0, colon), port }
}

/**
 * Parse a `ps -o lstart=` value into a sortable `YYYYMMDDHHMMSS` number and the
 * epoch milliseconds it represents.
 *
 * The two are separate because they serve different consumers: the number keeps
 * the published contract (the UI sorts on it), while the epoch is what the
 * identity check compares. Both come from the same parse so they cannot drift.
 * @param {string} text - e.g. `Thu May 21 14:10:00 2026`, under `LC_ALL=C`.
 * @returns {{ sortable: number, epochMs: number } | null} the parsed values, or
 *   null when the text is not an English `lstart` stamp.
 */
export function parseStartTime(text) {
  const trimmed = text.trim()
  if (trimmed === '') return null

  const match =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
      trimmed.replace(/\s+/g, ' '),
    )
  if (match === null) return null

  const month = MONTHS.get(match[1])
  if (month === undefined) return null

  const day = Number(match[2])
  const hour = Number(match[3])
  const minute = Number(match[4])
  const second = Number(match[5])
  const year = Number(match[6])

  // Local time, matching how `ps` prints it and how the original app treated it.
  const epochMs = new Date(year, month, day, hour, minute, second).getTime()
  if (!Number.isFinite(epochMs)) return null

  const sortable =
    year * 10_000_000_000 +
    (month + 1) * 100_000_000 +
    day * 1_000_000 +
    hour * 10_000 +
    minute * 100 +
    second

  return { sortable, epochMs }
}

/**
 * Derive a short display name from a full command line.
 *
 * `node /very/long/path/node_modules/.bin/vite --host` reads as `vite`, and an
 * app bundle reads as its executable rather than its launch arguments.
 * @param {string} command - the full command line.
 * @returns {string} the derived name, or an empty string when there is nothing to derive from.
 */
export function deriveProcessName(command) {
  const trimmed = command.trim()
  if (trimmed === '') return ''

  if (trimmed.includes('.app/Contents/MacOS/')) {
    const withoutArgs = trimmed.split(' --')[0]
    const last = withoutArgs.slice(withoutArgs.lastIndexOf('/') + 1)
    return last.trim()
  }

  // A Windows command line usually starts with a quoted path because the path
  // contains spaces. Splitting on whitespace first would read
  // `"C:\Program Files\nodejs\node.exe" --inspect` as the executable `Program`,
  // so the quoted form is unwrapped before any separator is looked for.
  const first = firstToken(trimmed)
  const base = first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1)
  // A command line that starts with a switch carries no image name in it. WSL
  // starts its relay as ` --mode 1 --vm-id {...}` with an empty argv[0], and the
  // flag was read as the program name: a Docker row showed up as `--mode` on
  // Windows. `ps` always prints the image first, so this returns nothing only
  // where the command line really has no name, and the caller falls back to the
  // platform's process table instead.
  if (base.startsWith('-')) return ''
  return base.trim()
}

/**
 * The executable part of a command line, with surrounding quotes removed.
 * @param {string} text - a trimmed command line.
 * @returns {string} the first token, or the whole quoted path.
 */
function firstToken(text) {
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1)
    return close === -1 ? text.slice(1) : text.slice(1, close)
  }
  return text.split(/\s+/)[0]
}

/**
 * Render a start time the way `ps -o lstart` prints it.
 *
 * Both platforms publish this string, so a row reads the same whichever machine
 * it came from. Windows could publish an ISO stamp instead, but an ISO stamp is
 * UTC: the list would show a different clock time from the one the process
 * actually started at, on the very row where "when did this start" is the
 * question. The names are spelled out rather than taken from `toLocaleString`,
 * whose output would follow the machine's locale and stop matching `ps`.
 * @param {Date} date - the instant, in local time.
 * @returns {string} e.g. `Thu May 21 14:10:00 2026`.
 */
export function formatStartTime(date) {
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    date.getMonth()
  ]
  const pad = (value) => String(value).padStart(2, '0')
  // `ps` pads a single-digit day with a space rather than a zero.
  const day = String(date.getDate()).padStart(2, ' ')
  return `${weekday} ${month} ${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${String(date.getFullYear())}`
}

/**
 * Split one `ps -ww -o pid=,lstart=,command=` line.
 *
 * The command is last and may itself contain spaces, so only the first seven
 * fields are positional; the remainder is rejoined. POSIX-only: Windows reads its
 * process detail as JSON.
 * @param {string} line - one output line.
 * @returns {{ pid: number, startedAt: string, command: string } | null} the parts, or null.
 */
export function parsePsLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return null

  const parts = trimmed.split(/\s+/)
  if (parts.length < 7) return null

  const pid = Number.parseInt(parts[0], 10)
  if (!Number.isInteger(pid) || pid <= 0) return null

  // weekday month day HH:MM:SS year
  return { pid, startedAt: parts.slice(1, 6).join(' '), command: parts.slice(6).join(' ') }
}

/**
 * Describe the listen scope of one row in words.
 * @param {readonly string[]} hosts - the bound addresses.
 * @param {readonly string[]} ipVersions - their families.
 * @returns {string} e.g. `IPv4 · 127.0.0.1`, or `-` when unbound.
 */
export function summarizeHosts(hosts, ipVersions) {
  if (hosts.length === 0) return '-'

  const label =
    ipVersions.length > 1
      ? 'IPv4 + IPv6'
      : ipVersions.length === 1
        ? ipVersions[0]
        : 'TCP'

  return `${label} · ${hosts.join('  |  ')}`
}
