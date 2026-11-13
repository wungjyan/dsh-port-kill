/**
 * Platform selection.
 *
 * One place decides which back end serves the host, so adding a platform means
 * adding a module and one branch here — never touching the shared scanning,
 * identity or HTTP layers. {@link capabilities} travels with the back end so the
 * rest of the plugin can state what a platform cannot do instead of failing
 * obscurely.
 */

/**
 * What every back end must provide.
 *
 * Documented rather than enforced: this project has no type checker, and a
 * missing member surfaces as a clear `undefined is not a function` at mount.
 * @typedef {object} PlatformBackend
 * @property {() => Promise<Array<object>>} scanListeners - every TCP listener.
 * @property {(port: number) => Promise<Array<object>>} scanPort - listeners on one port.
 * @property {(pid: number) => Promise<number[]>} scanPortsForPid - ports one process holds.
 * @property {(pids: readonly number[]) => Promise<Map<number, object>>} loadProcessInfo - commands and start times.
 * @property {(pids: readonly number[]) => Promise<Map<number, string>>} loadWorkingDirectories - pid → cwd.
 * @property {(pid: number, depth: number) => Promise<number[]>} ancestorChain - self-protection walk.
 * @property {() => string} currentUser - the logged-in account.
 * @property {object} capabilities - what the platform can and cannot do.
 */

/**
 * The capability set of a platform that has no back end.
 *
 * Everything is false, and the caller is expected to refuse the scan rather than
 * return an empty list — "nothing is listening" would be a lie about a platform
 * that was never read.
 * @type {object}
 */
export const UNSUPPORTED_CAPABILITIES = {
  supported: false,
  gracefulSignal: false,
  canReadWorkingDirectory: false,
  userAttribution: false,
  nameAttribution: false,
  signalLabels: { soft: 'TERM', hard: 'KILL' },
  reason: '当前平台没有端口扫描实现。目前已支持 macOS、Linux 与 Windows。',
}

/**
 * Pick the back end for a platform string.
 *
 * Split out from {@link loadBackend} so the mapping itself is testable without
 * loading a module or being on that platform.
 * @param {string} platform - a `process.platform` value.
 * @returns {'posix' | 'win32' | 'unsupported'} which back end applies.
 */
export function backendFor(platform) {
  if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd') return 'posix'
  if (platform === 'win32') return 'win32'
  return 'unsupported'
}

/**
 * Load the back end for this host.
 *
 * The import is dynamic so a Windows host never evaluates the POSIX module and
 * vice versa, and so an unsupported platform loads no back end at all.
 * @param {string} [platform] - override for tests; defaults to this host's.
 * @returns {Promise<PlatformBackend | null>} the back end, or null when unsupported.
 */
export async function loadBackend(platform = process.platform) {
  const kind = backendFor(platform)
  if (kind === 'posix') {
    const module = await import('./posix.js')
    return { ...module, capabilities: { ...module.capabilities } }
  }
  if (kind === 'win32') {
    const module = await import('./win32.js')
    return { ...module, capabilities: { ...module.capabilities } }
  }
  return null
}
