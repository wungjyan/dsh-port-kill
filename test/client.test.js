import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Load the client bundle the way the browser module loader does.
 *
 * The bundle only registers a factory; nothing runs until the factory is
 * materialized, which is the contract this test relies on.
 * @param {(name: string) => unknown} requireImpl - module table stand-in.
 * @returns {{ id: string, factory: Function }} the registration.
 */
function loadBundle(requireImpl) {
  let registration = null
  const fakeWindow = {
    __ModuleLoader__: {
      load: (value) => {
        registration = value
      },
    },
  }

  // The bundle is a classic script, not a module: evaluate it with the two
  // globals it expects and nothing else.
  const evaluate = new Function('window', 'require', clientSource)
  evaluate(fakeWindow, requireImpl)

  assert.notEqual(registration, null, 'bundle did not register a factory')
  return registration
}

/**
 * A minimal React stand-in.
 *
 * The assertions here are about registration and dictionary integrity, not about
 * rendering, so this records element trees instead of mounting them. Rendering is
 * covered by actually installing the plugin.
 * @returns {object} the fake React module.
 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    Fragment: Symbol('fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
}

describe('client bundle registration', () => {
  test('registers under the scoped package name', () => {
    const registration = loadBundle(() => fakeReact())
    // The id must equal the package name: the loader keys the boot graph on it.
    assert.equal(registration.id, '@wungjyan/dsh-port-kill')
  })

  test('requires only react from the module table', () => {
    const required = []
    const registration = loadBundle((name) => {
      required.push(name)
      if (name === 'react') return fakeReact()
      throw new Error(`unexpected require: ${name}`)
    })
    registration.factory((name) => {
      required.push(name)
      if (name === 'react') return fakeReact()
      throw new Error(`unexpected require: ${name}`)
    })
    assert.deepEqual([...new Set(required)], ['react'])
  })

  test('declares the services it needs', () => {
    const registration = loadBundle(() => fakeReact())
    const plugin = registration.factory(() => fakeReact())
    assert.deepEqual(plugin.inject, ['slots', 'locale'])
  })

  test('registers the panel and its sidebar entry on the same id', () => {
    const registration = loadBundle(() => fakeReact())
    const plugin = registration.factory(() => fakeReact())

    const registrations = []
    const injected = []
    const ctx = {
      get: () => undefined,
      effect: (fn) => {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      slots: {
        inject: (key, callback) => {
          injected.push(key)
          return callback()
        },
        register: (options) => {
          registrations.push(options)
          return () => {}
        },
      },
    }

    plugin.apply(ctx)

    assert.deepEqual(injected.sort(), ['main', 'plugins.bundle.config', 'sidebar.panellist'])

    const panelEntry = registrations.find((options) => options.name === 'main')
    assert.ok(panelEntry, 'no main panel registered')
    assert.equal(panelEntry.key, 'port-kill')

    const sidebarEntry = registrations.find((options) => options.name === 'sidebar.panellist')
    assert.ok(sidebarEntry, 'no sidebar entry registered')
    // The sidebar resolves its `main` panel from this id, so the two must agree.
    assert.equal(sidebarEntry.id, panelEntry.key)
    assert.equal(typeof sidebarEntry.label, 'function')
  })

  test('survives a context without a locale service', () => {
    const registration = loadBundle(() => fakeReact())
    const plugin = registration.factory(() => fakeReact())

    const ctx = {
      get: () => undefined,
      effect: (fn) => {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      slots: {
        inject: (key, callback) => callback(),
        register: () => () => {},
      },
    }

    assert.doesNotThrow(() => {
      plugin.apply(ctx)
    })
  })
})

describe('client copy', () => {
  test('carries both Chinese and English dictionaries with identical keys', () => {
    // Both dictionaries live in one object literal; comparing their key sets is
    // what keeps a new string from shipping in one language only.
    const zhStart = clientSource.indexOf('zh: {')
    const enStart = clientSource.indexOf('en: {')
    assert.ok(zhStart > 0 && enStart > zhStart)

    const zhBlock = clientSource.slice(zhStart, enStart)
    const enEnd = clientSource.indexOf('const PORT_HINTS')
    const enBlock = clientSource.slice(enStart, enEnd)

    const keysOf = (block) => new Set([...block.matchAll(/'([A-Za-z0-9]+)':/g)].map((match) => match[1]))
    const zhKeys = keysOf(zhBlock)
    const enKeys = keysOf(enBlock)

    assert.ok(zhKeys.size > 40, `expected a full dictionary, got ${String(zhKeys.size)} keys`)
    assert.deepEqual([...zhKeys].sort(), [...enKeys].sort())
  })

  test('defines every key the component asks for', () => {
    // A key is literal only when `t(` is immediately followed by the quote;
  // `t(choice.key)` passes a variable and must not be read as the key `key`.
  const used = new Set(
    [...clientSource.matchAll(/\bt\('([A-Za-z0-9]+)'\)/g)]
      .filter((match) => match.index === 0 || clientSource[match.index - 1] !== '.')
      .map((match) => match[1]),
  )
    const zhStart = clientSource.indexOf('zh: {')
    const enStart = clientSource.indexOf('en: {')
    const zhKeys = new Set(
      [...clientSource.slice(zhStart, enStart).matchAll(/'([A-Za-z0-9]+)':/g)].map((match) => match[1]),
    )

    const missing = [...used].filter((key) => !zhKeys.has(key))
    assert.deepEqual(missing, [], `missing dictionary keys: ${missing.join(', ')}`)
  })

  test('styles the panel from theme tokens, not literal colours', () => {
    const css = clientSource.slice(clientSource.indexOf('const CSS = `'), clientSource.indexOf('function PanelIcon'))

    // Every colour must be a token so light/dark switching needs no code. A hex
    // literal in the stylesheet is the failure this guards.
    const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])
    assert.deepEqual(hex, [], `literal colours found in CSS: ${hex.join(', ')}`)

    assert.ok(css.includes('--dsw-alias-bg-layer-1'))
    assert.ok(css.includes('--dsw-alias-label-primary'))
  })
})

describe('sidebar label follows the setting', () => {
  /**
   * Mount the plugin against a fake context that records registrations.
   * @param {string} localeId - the interface language the fake locale reports.
   * @returns {object} the recorded state and the live context.
   */
  function mount(localeId) {
    const registration = loadBundle(() => fakeReact())
    const plugin = registration.factory(() => fakeReact())

    const registrations = []
    const localeSubscribers = new Set()
    const locale = {
      getLocale: () => ({ active: localeId, locales: [], revision: 1 }),
      subscribe: (fn) => {
        localeSubscribers.add(fn)
        return () => localeSubscribers.delete(fn)
      },
      register: () => () => {},
      bind: () => (key) => key,
    }

    const ctx = {
      get: (name) => (name === 'locale' ? locale : undefined),
      effect: (fn) => {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      slots: {
        inject: (key, callback) => callback(),
        register: (options) => {
          registrations.push(options)
          return () => {}
        },
      },
    }

    plugin.apply(ctx)
    return { registrations, localeSubscribers }
  }

  const labelOf = (entry) => (typeof entry.label === 'function' ? entry.label() : entry.label)
  const sidebarLabels = (registrations) =>
    registrations
      .filter((options) => options.name === 'sidebar.panellist')
      .map(labelOf)

  test('defaults to the interface language', () => {
    const { registrations } = mount('zh')
    const labels = sidebarLabels(registrations)
    assert.equal(labels.at(-1), '端口管理', 'a Chinese interface gets the Chinese name')
  })

  test('an English interface gets the English name', () => {
    const { registrations } = mount('en')
    assert.equal(sidebarLabels(registrations).at(-1), 'Port Kill')
  })

  test('the entry is rebuilt when the interface language changes', () => {
    // The sidebar keeps the label it was registered with, so a language switch
    // only takes effect if the entry is registered again.
    const { registrations, localeSubscribers } = mount('zh')
    assert.equal(sidebarLabels(registrations).at(-1), '端口管理')
    for (const notify of localeSubscribers) notify()
    // The fake locale still reports `zh`, so the label is unchanged and no new
    // registration is added — the guard against pointless churn.
    assert.equal(sidebarLabels(registrations).length, 1)
  })

  test('a language switch that changes the text re-registers the entry', () => {
    const registration = loadBundle(() => fakeReact())
    const plugin = registration.factory(() => fakeReact())

    const registrations = []
    let active = 'zh'
    const localeSubscribers = new Set()
    const locale = {
      getLocale: () => ({ active, locales: [], revision: 1 }),
      subscribe: (fn) => {
        localeSubscribers.add(fn)
        return () => localeSubscribers.delete(fn)
      },
      register: () => () => {},
      bind: () => (key) => key,
    }
    plugin.apply({
      get: (name) => (name === 'locale' ? locale : undefined),
      effect: (fn) => {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      slots: {
        inject: (key, callback) => callback(),
        register: (options) => {
          registrations.push(options)
          return () => {}
        },
      },
    })

    assert.equal(sidebarLabels(registrations).at(-1), '端口管理')
    active = 'en'
    for (const notify of localeSubscribers) notify()
    assert.equal(sidebarLabels(registrations).at(-1), 'Port Kill')
    assert.equal(sidebarLabels(registrations).length, 2, 'exactly one rebuild')
  })
})

describe('stored setting reaches the sidebar at startup', () => {
  test('a saved English label is applied without opening any page', async () => {
    // The sidebar renders during startup, long before any of our components
    // mount. If the settings were only read when a page opened, the label would
    // stay on its default — which is exactly the bug this test pins down.
    const registration = loadBundle(() => fakeReact())
    const plugin = registration.factory(() => fakeReact())

    const registrations = []
    const locale = {
      getLocale: () => ({ active: 'zh', locales: [], revision: 1 }),
      subscribe: () => () => {},
      register: () => () => {},
      bind: () => (key) => key,
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (path) => ({
      ok: true,
      json: async () => {
        assert.equal(path, '/port-kill/settings', 'the label reads the settings route')
        return { ok: true, settings: { refreshMs: 10_000, navLabel: 'en' } }
      },
    })

    try {
      plugin.apply({
        get: (name) => (name === 'locale' ? locale : undefined),
        effect: (fn) => {
          const disposer = fn()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        slots: {
          inject: (key, callback) => callback(),
          register: (options) => {
            registrations.push(options)
            return () => {}
          },
        },
      })

      // The read is asynchronous; give the microtask queue a turn.
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    const labels = registrations
      .filter((options) => options.name === 'sidebar.panellist')
      .map((options) => (typeof options.label === 'function' ? options.label() : options.label))

    assert.equal(labels.at(-1), 'Port Kill', 'the stored English name must win over the interface language')
  })
})
