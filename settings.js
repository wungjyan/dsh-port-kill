/**
 * Port Kill — settings persistence.
 *
 * ## Why a file and not `localStorage`
 *
 * The Harness Web GUI is served from 127.0.0.1 on a port that changes between
 * launches (measured: 56060, 59631, 63274 across restarts), and `localStorage`
 * is keyed by origin — so every saved preference would come back as the default
 * after a restart. A JSON document under `DSH_HOME` (default `~/.dsh`) is stable
 * across ports, restarts and browser profiles.
 *
 * ## Why plain same-origin routes and not `ctx.remote`
 *
 * A build-free plain-JavaScript bundle cannot declare a typed `ctx.remote`
 * namespace: those need generated Typert descriptors. Two same-origin routes are
 * the transport the installed community plugins use for their own UI→Host calls.
 *
 *   GET  /port-kill/settings  → { ok, settings }
 *   POST /port-kill/settings  → { ok, settings }   (validated partial patch)
 *
 * ## Validation rules, and why they are strict
 *
 * A stale page, a hand-written request or a newer client must never persist a
 * value this build would misread. Every refusal carries a stable `code` plus a
 * message the settings form shows as-is.
 *
 * A file that parses but holds one unusable field is repaired field by field
 * rather than discarded: throwing the whole document away would silently reset
 * the settings that were still good, and the next write would make that loss
 * permanent.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where this plugin's settings live inside `DSH_HOME`. */
const DATA_DIRECTORY = 'port-kill'
const FILE_NAME = 'settings.json'

/** The refresh cadence choices, in milliseconds. `0` turns auto-refresh off. */
export const REFRESH_CHOICES = [0, 3_000, 5_000, 10_000, 15_000, 30_000, 60_000]

/** How the sidebar label resolves against the active interface language. */
export const NAV_LABEL_CHOICES = ['auto', 'zh', 'en']

/** The settings document, with every field at its default. */
export const DEFAULT_SETTINGS = {
  refreshMs: 10_000,
  navLabel: 'auto',
}

/** An error carrying the HTTP status the route should answer with. */
export class SettingsRefusal extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - stable identifier the form may branch on.
   * @param {string} message - text shown as-is.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'SettingsRefusal'
    this.status = status
    this.code = code
  }
}

/**
 * The Harness data root: `DSH_HOME` when set, else `~/.dsh`.
 *
 * Resolved per call so a profile launched with a different root keeps its own
 * settings.
 * @returns {string} absolute data root.
 */
function dataRoot() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * The settings document this plugin owns.
 * @returns {string} absolute path.
 */
export function settingsFile() {
  return join(dataRoot(), DATA_DIRECTORY, FILE_NAME)
}

/**
 * Check one refresh value against the published choices.
 *
 * An arbitrary interval is refused on purpose: the panel offers a fixed set, and
 * accepting a value it cannot display would leave the control showing something
 * the Host is not honouring.
 * @param {unknown} value - the proposed value.
 * @returns {number} the accepted value.
 * @throws {SettingsRefusal} when the value is not one of the choices.
 */
function checkRefresh(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !REFRESH_CHOICES.includes(value)) {
    throw new SettingsRefusal(
      400,
      'invalid-refresh',
      `refreshMs must be one of ${REFRESH_CHOICES.map(String).join(', ')}`,
    )
  }
  return value
}

/**
 * Check one sidebar-label mode.
 * @param {unknown} value - the proposed mode.
 * @returns {string} the accepted mode.
 * @throws {SettingsRefusal} when the value is not a known mode.
 */
function checkNavLabel(value) {
  if (typeof value !== 'string' || !NAV_LABEL_CHOICES.includes(value)) {
    throw new SettingsRefusal(
      400,
      'invalid-nav-label',
      `navLabel must be one of ${NAV_LABEL_CHOICES.join(', ')}`,
    )
  }
  return value
}

/**
 * Merge a patch over a complete document.
 *
 * Unknown keys are dropped rather than stored, so a newer client cannot leave
 * fields behind that this build would then have to guess about.
 * @param {object} current - the document to start from.
 * @param {object} patch - the fields to change.
 * @returns {object} the next complete document.
 * @throws {SettingsRefusal} when a supplied field is not acceptable.
 */
export function mergeSettings(current, patch) {
  const next = { refreshMs: current.refreshMs, navLabel: current.navLabel }

  if (patch.refreshMs !== undefined) next.refreshMs = checkRefresh(patch.refreshMs)
  if (patch.navLabel !== undefined) next.navLabel = checkNavLabel(patch.navLabel)

  return next
}

/**
 * Repair a stored document that failed validation, field by field.
 *
 * Keeps every value that still validates, so one bad field costs one setting
 * rather than the whole file.
 * @param {object} stored - the parsed document, known to fail validation.
 * @param {(fields: string[]) => void} [onRepair] - told which fields fell back.
 * @returns {object} a complete, validated document.
 */
export function repairSettings(stored, onRepair) {
  let state = { ...DEFAULT_SETTINGS }
  const dropped = []

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) continue
    try {
      state = mergeSettings(state, { [key]: stored[key] })
    } catch {
      dropped.push(key)
    }
  }

  if (dropped.length > 0 && typeof onRepair === 'function') onRepair(dropped)
  return state
}

/**
 * Read the stored settings.
 *
 * A missing, unreadable or unparseable file yields the defaults; nothing in it
 * can be salvaged. A file that parses but holds an unusable value is repaired
 * field by field.
 * @param {(fields: string[]) => void} [onRepair] - told which fields fell back.
 * @returns {Promise<object>} a complete, validated document.
 */
export async function readSettings(onRepair) {
  let raw
  try {
    raw = await readFile(settingsFile(), 'utf8')
  } catch {
    return { ...DEFAULT_SETTINGS }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS }
  }

  try {
    return mergeSettings(DEFAULT_SETTINGS, parsed)
  } catch {
    return repairSettings(parsed, onRepair)
  }
}

/**
 * Persist the settings, creating the directory on first write.
 *
 * The write goes through a temporary sibling so an interrupted save cannot leave
 * a half-written document behind.
 * @param {object} state - the complete document.
 * @returns {Promise<void>} resolution after the rename.
 */
export async function writeSettings(state) {
  const path = settingsFile()
  await mkdir(join(dataRoot(), DATA_DIRECTORY), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Resolve the sidebar label for one interface language.
 *
 * `auto` follows the interface, which is what most users want; the fixed modes
 * exist because someone may prefer an English plugin name inside a Chinese
 * interface (or the reverse), and that is a taste, not a mistake.
 * @param {object} settings - the document.
 * @param {string} localeId - the active interface language, e.g. `zh` or `en`.
 * @returns {'zh' | 'en'} which dictionary's label to use.
 */
export function navLabelLanguage(settings, localeId) {
  const mode = settings !== null && typeof settings === 'object' ? settings.navLabel : 'auto'
  if (mode === 'zh' || mode === 'en') return mode
  // Any non-Chinese interface falls back to the English label; a language this
  // plugin has no dictionary for should still read as itself.
  return String(localeId).startsWith('zh') ? 'zh' : 'en'
}
