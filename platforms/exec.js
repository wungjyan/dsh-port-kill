/**
 * Child-process execution shared by every platform back end.
 *
 * Kept separate from any one platform so a Windows back end can reuse it without
 * importing the POSIX one — the whole point of the split is that adding a
 * platform never touches the others.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Room for stdout on a machine with many listeners. */
export const MAX_BUFFER = 8 << 20

/**
 * The first candidate that exists on this machine, or the fallback.
 *
 * An absolute path is preferred because a Finder- or Dock-launched app inherits
 * a minimal PATH. But *which* absolute path holds a tool is not a fact about the
 * platform — macOS keeps `lsof` in `/usr/sbin`, Ubuntu installs it into
 * `/usr/bin` — so hardcoding one path is an assumption that breaks on the next
 * distribution. The fallback is the bare name, which the OS resolves through
 * PATH when no candidate matched.
 * @param {readonly string[]} candidates - absolute paths to try, in order.
 * @param {string} fallback - the bare command name.
 * @returns {string} the path to run.
 */
export function resolveBinary(candidates, fallback) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return fallback
}

/**
 * Run one system command and resolve with its stdout.
 *
 * `execFile`'s own `timeout` owns cancellation, so no shell and no manual kill
 * polling is involved. A non-zero exit is an error unless it is the empty-result
 * code the caller named.
 * @param {string} file - absolute executable path.
 * @param {readonly string[]} args - arguments.
 * @param {{ timeoutMs: number, emptyExitCode?: number, env?: Record<string, string> }} options - limits and environment overrides.
 * @returns {Promise<string>} stdout.
 * @throws {Error} when the command fails, times out, or overflows the buffer.
 */
export function run(file, args, { timeoutMs, emptyExitCode, env }) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        // Passed per call rather than written to `process.env`: several scans can
        // be in flight at once, and mutating shared state around an await lets one
        // call restore a value another call still depends on.
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      },
      (error, stdout) => {
        if (error === null || error === undefined) {
          resolve(String(stdout))
          return
        }
        // `lsof` reports "no matches" this way; it is not a failure.
        if (emptyExitCode !== undefined && error.code === emptyExitCode) {
          resolve(String(stdout ?? ''))
          return
        }
        // A spawn failure carries `code` but no signal at all — `signal` is
        // `undefined`, not `null` — so testing the signal first classified every
        // missing binary as a timeout and hid the real cause. This order is the
        // one that tells the truth about which of the two happened.
        if (error.code === 'ENOENT') {
          reject(new Error(`找不到可执行文件 ${file}，这个平台的端口扫描依赖它`))
          return
        }
        if (error.killed === true || typeof error.signal === 'string') {
          reject(new Error(`${file} 超时（${String(timeoutMs)}ms）后被终止`))
          return
        }
        const detail = String(error.stderr ?? '').trim()
        reject(
          new Error(
            detail === '' ? `无法执行 ${file}：${String(error.code)}` : detail,
          ),
        )
      },
    )
  })
}
