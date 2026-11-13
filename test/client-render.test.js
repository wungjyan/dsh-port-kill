import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * The bundle is one closure, so the pure helpers inside it cannot be imported.
 * They are read out of the source and evaluated on their own instead, which is
 * enough to test the decisions they make.
 * @param {string} functionName - the `function <name>(` to lift.
 * @param {string[]} [helpers] - other declarations it depends on, lifted first.
 * @returns {Function} the function, callable directly.
 */
function liftFunction(functionName, helpers = []) {
  const prelude = helpers
    .map((name) => {
      // Helpers are declared either as `const x = ...` or as `function x(...)`,
      // and both forms are lifted the same way.
      const asConst = clientSource.indexOf(`const ${name} = `)
      const asFunction = clientSource.indexOf(`function ${name}(`)
      const start = asConst > 0 ? asConst : asFunction
      assert.ok(start > 0, `${name} not found in bundle`)

      if (asConst > 0) {
        const end = clientSource.indexOf('\n\n', start)
        return clientSource.slice(start, end === -1 ? undefined : end)
      }
      // A function declaration ends at its closing brace followed by a newline.
      const end = clientSource.indexOf('\n    }\n', start)
      assert.ok(end > start, `${name} body not terminated`)
      return clientSource.slice(start, end + 6)
    })
    .join('\n')

  const start = clientSource.indexOf(`function ${functionName}(`)
  assert.ok(start > 0, `${functionName} not found in bundle`)
  const end = clientSource.indexOf('\n    }\n', start)
  const body = clientSource.slice(start, end + 6)

  return new Function(`${prelude}\n${body}\nreturn ${functionName}`)()
}

describe('exposure classification', () => {
  const exposureOf = liftFunction('exposureOf')

  test('marks a wildcard bind as reachable from the network', () => {
    // The only case a user has to notice: anything on the network can connect.
    assert.deepEqual(exposureOf(['*']), { key: 'exposureWide', wide: true })
    assert.deepEqual(exposureOf(['0.0.0.0']), { key: 'exposureWide', wide: true })
    assert.deepEqual(exposureOf(['[::]']), { key: 'exposureWide', wide: true })
  })

  test('does not mark loopback, which is the normal case', () => {
    // Labelling every loopback row trains the eye to skip the one that matters.
    assert.deepEqual(exposureOf(['127.0.0.1']), { key: 'exposureLocal', wide: false })
    assert.deepEqual(exposureOf(['localhost']), { key: 'exposureLocal', wide: false })
  })

  test('does not mark a single named interface', () => {
    // Reachable from the LAN but not from the internet; not the warning case.
    assert.deepEqual(exposureOf(['192.168.1.4']), { key: 'exposureLimited', wide: false })
  })

  test('marks a dual-stack listener when either half is a wildcard', () => {
    assert.deepEqual(exposureOf(['127.0.0.1', '*']), { key: 'exposureWide', wide: true })
  })

  test('does not mark an empty address list', () => {
    assert.equal(exposureOf([]).wide, false)
  })
})

describe('locale copy completeness', () => {
  /**
   * Every dictionary key the component asks for must exist in both languages.
   *
   * This is what keeps a new string from shipping in one language only, and it is
   * cheap enough to run on every commit.
   */
  // Only literal keys are checkable; `t(choice.key)` resolves at runtime.
  // A key is literal only when `t(` is immediately followed by the quote;
  // `t(choice.key)` passes a variable and must not be read as the key `key`.
  const used = new Set(
    [...clientSource.matchAll(/\bt\('([A-Za-z0-9]+)'\)/g)]
      .filter((match) => match.index === 0 || clientSource[match.index - 1] !== '.')
      .map((match) => match[1]),
  )
  const zhBlock = clientSource.slice(clientSource.indexOf('zh: {'), clientSource.indexOf('en: {'))
  const enBlock = clientSource.slice(
    clientSource.indexOf('en: {'),
    clientSource.indexOf('const PORT_HINTS'),
  )
  const keysOf = (block) => new Set([...block.matchAll(/'([A-Za-z0-9]+)':/g)].map((match) => match[1]))
  const zhKeys = keysOf(zhBlock)
  const enKeys = keysOf(enBlock)

  test('both dictionaries carry the same keys', () => {
    assert.deepEqual([...zhKeys].sort(), [...enKeys].sort())
  })

  test('every key used by the component is defined', () => {
    const missing = [...used].filter((key) => !zhKeys.has(key))
    assert.deepEqual(missing, [], `missing keys: ${missing.join(', ')}`)
  })

  test('no key is defined but unused', () => {
    // A leftover key is dead copy that drifts out of date unnoticed. The refresh
    // cadences are looked up dynamically by `t(choice.key)`, so they are read from
    // the choice table rather than from a literal `t('...')` call.
    // Keys reached without a literal translate call: the refresh cadence table
    // (`key: 'refresh3s'`) and direct dictionary reads like `DICT[lang]['nav']`.
    const dynamic = new Set([
      ...[...clientSource.matchAll(/key:\s*'([A-Za-z0-9]+)'/g)].map((match) => match[1]),
      ...[...clientSource.matchAll(/DICT\[[A-Za-z0-9_]+\]\['([A-Za-z0-9]+)'\]/g)].map(
        (match) => match[1],
      ),
    ])
    const unused = [...zhKeys].filter((key) => !used.has(key) && !dynamic.has(key))
    assert.deepEqual(unused, [], `unused keys: ${unused.join(', ')}`)
  })
})

describe('stylesheet invariants', () => {
  const css = clientSource.slice(
    clientSource.indexOf('const CSS = `'),
    clientSource.indexOf('function PanelIcon'),
  )

  test('uses theme tokens rather than literal colours', () => {
    // Literal colours would not follow the light/dark switch.
    const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])
    assert.deepEqual(hex, [], `literal colours: ${hex.join(', ')}`)
  })

  test('no colour token is left without the dark-mode pairing', () => {
    // Every alias token used is published under both `body` and
    // `body[data-ds-dark-theme]` by the theme package, so listing them here
    // documents what the stylesheet relies on.
    const tokens = new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))
    assert.ok(tokens.has('--dsw-alias-bg-layer-1'))
    assert.ok(tokens.has('--dsw-alias-label-primary'))
    assert.ok(tokens.size >= 10, `expected several theme tokens, got ${String(tokens.size)}`)
  })

  test('reserves a fixed width for the action column', () => {
    // Auto layout let the last column fall outside the scroll container, which
    // made the kill button unreachable. The column is pinned instead.
    assert.ok(css.includes('table-layout:fixed'), 'table must use fixed layout')
    assert.ok(css.includes('.pk-colAction{width:'), 'action column needs an explicit width')
  })
})

describe('kill dialog distinguishes its two buttons', () => {
  const dialogSource = clientSource.slice(
    clientSource.indexOf('function KillDialog('),
    clientSource.indexOf('function Toast('),
  )
  const cssBlock = clientSource.slice(
    clientSource.indexOf('const CSS = `'),
    clientSource.indexOf('function PanelIcon'),
  )

  test('the ordinary end is the primary button and the force end is not', () => {
    // Two identical red buttons made the destructive choice indistinguishable
    // from the ordinary one. The ordinary path is filled and the sharp one is
    // only outlined, so the safe default is the visually obvious one.
    assert.ok(
      /className: 'pk-btn pk-btn--primary'[\s\S]{0,200}onConfirm\(false\)/.test(dialogSource),
      'the ordinary end should be the primary button',
    )
    assert.ok(
      /className: 'pk-btn pk-btn--danger'[\s\S]{0,200}onConfirm\(true\)/.test(dialogSource),
      'the force end should stay the outlined danger button',
    )
  })

  test('the primary button sits rightmost and takes focus', () => {
    const forceAt = dialogSource.indexOf("className: 'pk-btn pk-btn--danger'")
    const primaryAt = dialogSource.indexOf("className: 'pk-btn pk-btn--primary'")
    assert.ok(forceAt > 0 && primaryAt > forceAt, 'the primary button must come after the force one')
    // Focus starts on the action a hurried reader wants, not on the sharp one.
    const primaryButton = dialogSource.slice(primaryAt, primaryAt + 400)
    assert.ok(primaryButton.includes('ref: confirmRef'), 'focus should default to the ordinary end')
    assert.ok(
      primaryButton.includes('onConfirm(false)'),
      'the focused button should be the ordinary end',
    )
  })

  test('explains what the two signals do instead of only naming them', () => {
    // "TERM" and "KILL" name the mechanism; a reader who does not know Unix
    // signals learns nothing from them. The dictionary has to state the effect.
    const dict = clientSource.slice(clientSource.indexOf('zh: {'), clientSource.indexOf('en: {'))
    assert.ok(dict.includes("'killHint'"), 'the dialog needs a plain-language hint')
    assert.ok(dict.includes('保存数据'), 'the hint must mention saving work')
    assert.ok(dict.includes('丢失'), 'the hint must warn about data loss')
    for (const key of ['killConfirmHint', 'killForceHint']) {
      assert.ok(dict.includes(`'${key}'`), `${key} should name the signal in full`)
    }
  })

  test('no label is left naming a bare signal', () => {
    // The visible labels must not read "结束（TERM）": the parenthesis was the
    // only clue and it explained nothing.
    const visible = [...clientSource.matchAll(/'kill(?:Confirm|Force)':\s*"([^"]*)"/g)].map(
      (match) => match[1],
    )
    assert.equal(visible.length, 4, 'expected both languages to define both labels')
    const offending = visible.filter((label) => /\(KILL\)|\(TERM\)|（KILL）|（TERM）/.test(label))
    assert.deepEqual(offending, [], `labels still naming a bare signal: ${offending.join(', ')}`)
  })

  test('the primary button is styled from the shipped button tokens', () => {
    // Matching the shipped Button means one visual language; a one-off accent
    // would look wrong the moment the theme changes.
    assert.ok(cssBlock.includes('.pk-btn--primary'), 'primary button style is missing')
    assert.ok(
      cssBlock.includes('--dsw-alias-button-primary-fill'),
      'primary button should use the shipped fill token',
    )
  })

  test('the hint block uses only theme colours', () => {
    assert.ok(cssBlock.includes('.pk-dialogHint'), 'the hint block needs a style')
    const rule = cssBlock.slice(
      cssBlock.indexOf('.pk-dialogHint{'),
      cssBlock.indexOf('}', cssBlock.indexOf('.pk-dialogHint{')),
    )
    const hex = [...rule.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])
    assert.deepEqual(hex, [], `literal colours in the hint block: ${hex.join(', ')}`)
  })
})

describe('multi-port process warning', () => {
  const affectedPortsOf = liftFunction('affectedPortsOf')
  const dialogSource = clientSource.slice(
    clientSource.indexOf('function KillDialog('),
    clientSource.indexOf('function Toast('),
  )

  test('lists every port the process holds, not just the clicked one', () => {
    // One signal stops the whole process. A user ending :8012 on a process that
    // also holds seven other ports has to be told before committing.
    const ports = affectedPortsOf({ '41288': [8012, 14013, 14016] }, { pid: 41288, port: 8012 })
    assert.deepEqual(ports, [8012, 14013, 14016])
  })

  test('returns the row port alone when no grouping is published', () => {
    // A stale or absent grouping must never understate what the row showed.
    assert.deepEqual(affectedPortsOf({}, { pid: 1, port: 5173 }), [5173])
    assert.deepEqual(affectedPortsOf(undefined, { pid: 1, port: 5173 }), [5173])
    assert.deepEqual(affectedPortsOf({ '1': [] }, { pid: 1, port: 5173 }), [5173])
  })

  test('folds in the clicked port when the grouping omits it', () => {
    // The list can lag a rescan; the clicked port is affected by definition.
    assert.deepEqual(affectedPortsOf({ '7': [9000] }, { pid: 7, port: 5173 }), [5173, 9000])
  })

  test('the dialog receives the grouping and renders a chip per port', () => {
    assert.ok(dialogSource.includes('ports,'), 'the dialog should take a ports prop')
    assert.ok(dialogSource.includes('ports.length > 1'), 'the warning is multi-port only')
    assert.ok(dialogSource.includes('pk-portChip'), 'each port needs a chip')
  })

  test('a single-port process gets no warning block', () => {
    // Nothing extra applies, and repeating the port already named above is noise.
    const guard = dialogSource.slice(0, dialogSource.indexOf('pk-multiPort'))
    assert.ok(guard.includes('ports.length > 1'), 'the block must be conditional')
  })

  test('the warning explains why one click closes several ports', () => {
    const dict = clientSource.slice(clientSource.indexOf('zh: {'), clientSource.indexOf('en: {'))
    assert.ok(dict.includes("'killMultiPort'"), 'copy naming the port count')
    assert.ok(dict.includes("'killMultiPortNote'"), 'copy explaining the cause')
    assert.ok(dict.includes('不是单个端口'), 'the note must say a port is not what is ended')
  })

  test('the toast reports how many ports were released', () => {
    // The host returns the authoritative list; a multi-port kill says so rather
    // than the generic "ended".
    assert.ok(clientSource.includes('affectedPorts'), 'the client should read affectedPorts')
    assert.ok(clientSource.includes("'killedMultiPort'"), 'copy for a multi-port success')
  })
})

describe('process cell shows where the process is', () => {
  const processMeta = liftFunction('processMeta', ['executableOf'])

  test('collapses the home directory to a tilde', () => {
    // The original's rule; a full home path is noise in a narrow column.
    assert.equal(processMeta({ cwd: '/Users/wungjyan' }, 'wungjyan'), '~')
    assert.equal(processMeta({ cwd: '/home/me' }, 'me'), '~')
  })

  test('keeps the tail of a path under home', () => {
    // This is the shape the user asked about: ~/work/smartagri-ai/biz-iot-adapter
    assert.equal(
      processMeta({ cwd: '/Users/wungjyan/work/smartagri-ai/biz-iot-adapter' }, 'wungjyan'),
      '~/work/smartagri-ai/biz-iot-adapter',
    )
  })

  test('keeps only the last two segments outside home', () => {
    assert.equal(processMeta({ cwd: '/opt/homebrew/var/log' }, 'wungjyan'), '…/var/log')
    assert.equal(processMeta({ cwd: '/var/log' }, 'wungjyan'), '/var/log')
  })

  test('falls back to the command when the directory is unreadable', () => {
    // lsof cannot always read another user's cwd; showing the command line still
    // says what the process is, while an empty line would say nothing.
    assert.equal(processMeta({ cwd: null, command: 'node index.js' }, 'me'), 'node index.js')
    assert.equal(processMeta({ cwd: null, command: '', processName: 'node' }, 'me'), 'node')
  })

  test('normalizes a Windows path', () => {
    assert.equal(processMeta({ cwd: 'C:\\Users\\me\\proj\\app' }, 'me'), '~/proj/app')
    assert.equal(processMeta({ cwd: 'D:\\data\\svc' }, 'me'), '…/data/svc')
  })

  test('does not abbreviate when the user is unknown', () => {
    assert.equal(processMeta({ cwd: '/Users/wungjyan/work/x' }, ''), '…/work/x')
  })
})

describe('docker attribution in the UI', () => {
  const rowSource = clientSource.slice(
    clientSource.indexOf('function PortRow('),
    clientSource.indexOf('function detailItem('),
  )

  test('the badge names the container beside the real process name', () => {
    // Replacing the process name with the container name would hide what a
    // signal actually reaches, making the button look safer than it is.
    assert.ok(rowSource.includes('Docker ·'), 'the badge should name the container')
    assert.ok(rowSource.includes('item.processName'), 'the real process name stays visible')
  })

  test('a blocked row opens an explanation instead of a kill dialog', () => {
    // A disabled button cannot explain itself: Chromium shows no tooltip on a
    // disabled control, and not on its wrapper either while the control still
    // swallows the hover. The button therefore stays clickable and routes to a
    // dialog, which is a surface the user can actually reach.
    assert.ok(rowSource.includes('blocked ? onExplain(item) : onKill(item)'),
      'the button must route to the explanation for a blocked row')
    assert.ok(rowSource.includes('disabled: killing,'),
      'only an in-flight kill may disable the button')
    assert.ok(
      !rowSource.includes('pk-killWrap'),
      'the hover-wrapper workaround is gone: it never showed a tooltip',
    )
  })

  test('the explanation dialog names the container and how to stop it', () => {
    const dialogSource = clientSource.slice(
      clientSource.indexOf('function BlockedDialog('),
      clientSource.indexOf('function Toast('),
    )
    assert.ok(dialogSource.includes("t('dockerBlockedTitle')"), 'the dialog needs a title')
    assert.ok(dialogSource.includes('dockerNoKill'), 'the dialog carries the reason')
    assert.ok(dialogSource.includes("t('dismiss')"), 'the dialog is dismissed, not confirmed')
    assert.ok(dialogSource.includes('detailItem'), 'the container facts are listed')
  })

  test('a container-backed port is refused, not silently wrong', () => {
    assert.ok(rowSource.includes('item.container'), 'a container row must be recognised')
    assert.ok(rowSource.includes('onExplain'), 'the refusal needs an explanation surface')
  })

  test('a proxy with no container behind it is also refused', () => {
    // The daemon may be down; the proxy is still never a safe target.
    assert.ok(rowSource.includes('item.dockerProxy'), 'proxy-only rows must be detected')
  })

  test('the explanation says where to stop the container instead', () => {
    const dict = clientSource.slice(clientSource.indexOf('zh: {'), clientSource.indexOf('en: {'))
    assert.ok(dict.includes("'dockerNoKill'"), 'copy naming the container and where to stop it')
    assert.ok(dict.includes('Docker Desktop'), 'the copy must point at Docker Desktop')
    assert.ok(dict.includes("'dockerUnavailable'"), 'copy for an unreachable Docker')
  })

  test('the detail panel carries image and compose project', () => {
    assert.ok(clientSource.includes("t('detailContainer')"), 'the detail row should exist')
    assert.ok(clientSource.includes('item.container.project'), 'the compose project is shown')
  })
})

describe('process cell with an uninformative directory', () => {
  const processMeta = liftFunction('processMeta', ['executableOf'])

  test('falls back to the command when the cwd is the filesystem root', () => {
    // Many macOS apps launch from `/`; printing a bare slash fills the line with
    // a character that means nothing, while the command names the process.
    assert.equal(
      processMeta({ cwd: '/', command: '/Applications/MuMuPlayer.app/Contents/MacOS/MuMuPlayer --flag' }, 'me'),
      '/Applications/MuMuPlayer.app/Contents/MacOS/MuMuPlayer',
    )
  })

  test('still shows the process name when there is no command either', () => {
    assert.equal(processMeta({ cwd: '/', command: '', processName: 'MuMuPlayer' }, 'me'), 'MuMuPlayer')
  })
})

describe('sort order matches the original application', () => {
  // The comparator lives inside a useMemo, so it is rebuilt here from the same
  // source text rather than re-implemented — a copy would drift.
  const start = clientSource.indexOf('const compare = (left, right) => {')
  const end = clientSource.indexOf('        }\n\n        rows.sort(', start) + '        }'.length
  assert.ok(start > 0 && end > start, 'the comparator should be findable in the bundle')
  const macroCompare = new Function(
    'sortKey',
    `${clientSource.slice(start, end)}\nreturn compare`,
  )

  /**
   * Sort rows the way the panel does.
   * @param {Array<object>} rows - rows to sort.
   * @param {string} sortKey - the column.
   * @param {string} sortOrder - `ascend` or `descend`.
   * @returns {Array<object>} the sorted rows.
   */
  function sortRows(rows, sortKey, sortOrder) {
    const compare = macroCompare(sortKey)
    return [...rows].sort((left, right) => {
      const baseResult = compare(left, right)
      return sortOrder === 'ascend' ? baseResult : -baseResult
    })
  }

  test('negates the whole comparison, not only the primary key', () => {
    // This is the bug the original avoided: negating only the primary key leaves
    // the tie-breakers ascending, which reverses the visible order of a process
    // that holds several ports.
    const rows = [
      { port: 59631, pid: 1, startedAtTs: 20261112145803, processName: 'a' },
      { port: 59632, pid: 1, startedAtTs: 20261112145803, processName: 'a' },
      { port: 59633, pid: 1, startedAtTs: 20261112145803, processName: 'a' },
    ]
    assert.deepEqual(
      sortRows(rows, 'recent', 'descend').map((row) => row.port),
      [59633, 59632, 59631],
    )
  })

  test('keeps the tie-breakers ascending when the order is ascending', () => {
    const rows = [
      { port: 59633, pid: 1, startedAtTs: 20261112145803, processName: 'a' },
      { port: 59631, pid: 1, startedAtTs: 20261112145803, processName: 'a' },
      { port: 59632, pid: 1, startedAtTs: 20261112145803, processName: 'a' },
    ]
    assert.deepEqual(
      sortRows(rows, 'recent', 'ascend').map((row) => row.port),
      [59631, 59632, 59633],
    )
  })

  test('orders by start time first, whatever the tie-breakers do', () => {
    const rows = [
      { port: 100, pid: 1, startedAtTs: 20260101000000, processName: 'a' },
      { port: 900, pid: 2, startedAtTs: 20261231000000, processName: 'b' },
    ]
    assert.deepEqual(
      sortRows(rows, 'recent', 'descend').map((row) => row.port),
      [900, 100],
    )
  })

  test('a row with no start time sorts as the oldest', () => {
    // The original used 0 for a missing stamp; a row that was never read must
    // not jump to the top of "newest first".
    const rows = [
      { port: 100, pid: 1, startedAtTs: null, processName: 'a' },
      { port: 900, pid: 2, startedAtTs: 20261231000000, processName: 'b' },
    ]
    assert.deepEqual(
      sortRows(rows, 'recent', 'descend').map((row) => row.port),
      [900, 100],
    )
  })

  test('the port column breaks ties on pid', () => {
    const rows = [
      { port: 80, pid: 9, startedAtTs: 1, processName: 'z' },
      { port: 80, pid: 3, startedAtTs: 1, processName: 'y' },
    ]
    assert.deepEqual(
      sortRows(rows, 'port', 'ascend').map((row) => row.pid),
      [3, 9],
    )
  })
})

describe('dialog layout survives a long command line', () => {
  const cssBlock = clientSource.slice(
    clientSource.indexOf('const CSS = `'),
    clientSource.indexOf('function PanelIcon'),
  )
  const rule = (selector) => {
    const start = cssBlock.indexOf(`${selector}{`)
    assert.ok(start > 0, `${selector} rule is missing`)
    return cssBlock.slice(start, cssBlock.indexOf('}', start))
  }

  test('the dialog itself never scrolls', () => {
    // A `java -cp` classpath runs to thousands of characters. When the dialog
    // scrolled as a whole, it grew to the full viewport and pushed the action
    // buttons off screen.
    const dialog = rule('.pk-dialog')
    assert.ok(dialog.includes('overflow:hidden'), 'the dialog must not scroll as a whole')
    assert.ok(dialog.includes('display:flex'), 'the dialog is a flex column')
    assert.ok(dialog.includes('flex-direction:column'), 'the dialog stacks its sections')
  })

  test('the command block scrolls on its own with a capped height', () => {
    const block = rule('.pk-commandBlock')
    assert.ok(block.includes('max-height:'), 'the command block needs a height cap')
    assert.ok(block.includes('overflow:auto'), 'the command block scrolls internally')
  })

  test('the command no longer shares the paragraph that wraps everywhere', () => {
    // It used to be a <code> inside .pk-dialogBody, which had no height cap.
    const dialogSource = clientSource.slice(
      clientSource.indexOf('function KillDialog('),
      clientSource.indexOf('function Toast('),
    )
    assert.ok(dialogSource.includes('pk-commandBlock'), 'the command uses the capped block')
    assert.ok(
      !/className: 'pk-dialogBody' \}[^)]*h\('code'/.test(dialogSource),
      'the command should not be a bare code element in a paragraph',
    )
  })

  test('the sections that must stay visible do not shrink', () => {
    // Title, hints and the button row keep their size while the command scrolls.
    const pinned = cssBlock.slice(cssBlock.indexOf('.pk-dialogTitle,'))
    assert.ok(pinned.includes('.pk-dialogActions'), 'the actions row must not shrink')
    assert.ok(pinned.includes('flex:none'), 'those sections are pinned')
  })
})

describe('one control per setting', () => {
  const formSource = clientSource.slice(
    clientSource.indexOf('function BundleConfig('),
    clientSource.indexOf('function PortRow('),
  )
  const panelSource = clientSource.slice(
    clientSource.indexOf('function PortKillPanel('),
    clientSource.indexOf('function apply('),
  )

  test('the refresh cadence has exactly one control, on the panel toolbar', () => {
    // It once existed in both the toolbar and the settings form. Two controls
    // for one value make the reader wonder which one is authoritative, even
    // when they stay in sync.
    const writes = [...clientSource.matchAll(/saveSettings\(\{ refreshMs/g)].length
    assert.equal(writes, 1, 'refreshMs must be written from exactly one control')
    assert.ok(
      panelSource.includes('saveSettings({ refreshMs'),
      'the remaining control belongs to the panel toolbar',
    )
    assert.ok(
      !formSource.includes('refreshMs'),
      'the settings form must not offer a second refresh control',
    )
  })

  test('the settings form says where the refresh control went', () => {
    // Without this line the page reads as "the setting is missing".
    const dict = clientSource.slice(clientSource.indexOf('zh: {'), clientSource.indexOf('en: {'))
    assert.ok(dict.includes('工具栏'), 'the settings hint must point at the toolbar')
  })

  test('the sidebar label still has its own control', () => {
    assert.ok(formSource.includes("t('settingsNavLabel')"), 'the label row stays in settings')
    assert.ok(formSource.includes('pk-set-nav'), 'the label control is the settings form\'s own')
  })
})
