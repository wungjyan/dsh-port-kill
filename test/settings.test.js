import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SETTINGS,
  NAV_LABEL_CHOICES,
  REFRESH_CHOICES,
  SettingsRefusal,
  mergeSettings,
  navLabelLanguage,
  repairSettings,
  settingsFile,
} from '../settings.js'

describe('settings defaults', () => {
  test('refreshes every ten seconds by default', () => {
    assert.equal(DEFAULT_SETTINGS.refreshMs, 10_000)
  })

  test('follows the interface language by default', () => {
    assert.equal(DEFAULT_SETTINGS.navLabel, 'auto')
  })

  test('offers the full set of refresh cadences', () => {
    // The original application offered six intervals plus an off switch; the
    // first version of this plugin shipped only four choices.
    assert.deepEqual(REFRESH_CHOICES, [0, 3_000, 5_000, 10_000, 15_000, 30_000, 60_000])
  })

  test('stores settings under the Harness data root', () => {
    const path = settingsFile()
    assert.ok(path.endsWith('/port-kill/settings.json'), path)
  })
})

describe('settings validation', () => {
  test('accepts every published refresh cadence', () => {
    for (const value of REFRESH_CHOICES) {
      assert.equal(mergeSettings(DEFAULT_SETTINGS, { refreshMs: value }).refreshMs, value)
    }
  })

  test('refuses an interval the panel cannot display', () => {
    // Accepting 7s would leave the control showing a value the Host ignores.
    assert.throws(
      () => mergeSettings(DEFAULT_SETTINGS, { refreshMs: 7_000 }),
      (error) => error instanceof SettingsRefusal && error.code === 'invalid-refresh',
    )
  })

  test('refuses a non-integer or negative interval', () => {
    for (const value of [1_000.5, -1, Number.NaN, '3000', null]) {
      assert.throws(
        () => mergeSettings(DEFAULT_SETTINGS, { refreshMs: value }),
        (error) => error.code === 'invalid-refresh',
        `${String(value)} should be refused`,
      )
    }
  })

  test('accepts every published label mode', () => {
    for (const mode of NAV_LABEL_CHOICES) {
      assert.equal(mergeSettings(DEFAULT_SETTINGS, { navLabel: mode }).navLabel, mode)
    }
  })

  test('refuses an unknown label mode', () => {
    assert.throws(
      () => mergeSettings(DEFAULT_SETTINGS, { navLabel: 'fr' }),
      (error) => error.code === 'invalid-nav-label',
    )
  })

  test('drops unknown keys instead of storing them', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { refreshMs: 5_000, evil: 'x' })
    assert.deepEqual(merged, { refreshMs: 5_000, navLabel: 'auto' })
  })

  test('a patch that changes nothing still returns a complete document', () => {
    assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS)
  })
})

describe('repairing a stored document', () => {
  test('keeps the fields that still validate', () => {
    // Discarding the whole file would silently reset settings that were fine,
    // and the next write would make that loss permanent.
    const repaired = repairSettings({ refreshMs: 60_000, navLabel: 'nonsense' })
    assert.equal(repaired.refreshMs, 60_000)
    assert.equal(repaired.navLabel, 'auto')
  })

  test('reports which fields fell back', () => {
    const dropped = []
    repairSettings({ refreshMs: 1_234, navLabel: 'en' }, (fields) => dropped.push(...fields))
    assert.deepEqual(dropped, ['refreshMs'])
  })

  test('returns the defaults for an empty document', () => {
    assert.deepEqual(repairSettings({}), DEFAULT_SETTINGS)
  })

  test('stays idempotent: repairing a repaired document changes nothing', () => {
    const once = repairSettings({ refreshMs: 1_234, navLabel: 'zh' })
    const twice = repairSettings(once)
    assert.deepEqual(twice, once)
  })
})

describe('sidebar label language', () => {
  test('auto follows a Chinese interface', () => {
    assert.equal(navLabelLanguage({ navLabel: 'auto' }, 'zh'), 'zh')
    assert.equal(navLabelLanguage({ navLabel: 'auto' }, 'zh-CN'), 'zh')
  })

  test('auto follows an English interface', () => {
    assert.equal(navLabelLanguage({ navLabel: 'auto' }, 'en'), 'en')
  })

  test('auto falls back to English for a language with no dictionary', () => {
    // A Japanese interface should still read as the plugin's own name rather
    // than an untranslated key.
    assert.equal(navLabelLanguage({ navLabel: 'auto' }, 'ja'), 'en')
    assert.equal(navLabelLanguage({ navLabel: 'auto' }, undefined), 'en')
  })

  test('a fixed mode wins over the interface language', () => {
    // The whole point of the setting: an English plugin name inside a Chinese
    // interface is a taste, not a mistake.
    assert.equal(navLabelLanguage({ navLabel: 'en' }, 'zh'), 'en')
    assert.equal(navLabelLanguage({ navLabel: 'zh' }, 'en'), 'zh')
  })

  test('a missing or broken document behaves like auto', () => {
    assert.equal(navLabelLanguage(null, 'zh'), 'zh')
    assert.equal(navLabelLanguage({}, 'zh'), 'zh')
    assert.equal(navLabelLanguage({ navLabel: 'bogus' }, 'en'), 'en')
  })
})
