/**
 * Child-process execution shared by every platform back end.
 *
 * Kept separate from any one platform so a Windows back end can reuse it without
 * importing the POSIX one — the whole point of the split is that adding a
 * platform never touches the others.
 */
import { execFile } from 'node:child_process'

/** Room for stdout on a machine with many listeners. */
export const MAX_BUFFER = 8 << 20

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
        if (error.killed === true || error.signal !== null) {
          reject(new Error(`${file} 超时（${String(timeoutMs)}ms）后被终止`))
          return
        }
        if (error.code === 'ENOENT') {
          reject(new Error(`找不到可执行文件 ${file}，这个平台的端口扫描依赖它`))
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
