import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseLsofStream,
  parseAddress,
  ipVersionOf,
  parseStartTime,
  parsePsLine,
  deriveProcessName,
  summarizeHosts,
  matchesQuery,
} from '../host.js'

describe('parseAddress', () => {
  test('splits an IPv4 bind', () => {
    assert.deepEqual(parseAddress('127.0.0.1:5173'), { host: '127.0.0.1', port: 5173 })
  })

  test('splits a wildcard bind', () => {
    assert.deepEqual(parseAddress('*:8080'), { host: '*', port: 8080 })
  })

  test('splits a bracketed IPv6 bind', () => {
    assert.deepEqual(parseAddress('[::1]:3000'), { host: '[::1]', port: 3000 })
  })

  test('keeps only the local half of a connected socket', () => {
    assert.deepEqual(parseAddress('127.0.0.1:8080->127.0.0.1:54321'), {
      host: '127.0.0.1',
      port: 8080,
    })
  })

  test('rejects an address with no port', () => {
    assert.equal(parseAddress('127.0.0.1'), null)
  })

  test('rejects port zero', () => {
    assert.equal(parseAddress('127.0.0.1:0'), null)
  })

  test('rejects a port above the range', () => {
    assert.equal(parseAddress('127.0.0.1:70000'), null)
  })
})

describe('ipVersionOf', () => {
  test('treats a wildcard as IPv4', () => {
    assert.equal(ipVersionOf('*'), 'IPv4')
  })

  test('detects IPv4', () => {
    assert.equal(ipVersionOf('192.168.1.4'), 'IPv4')
  })

  test('detects IPv6 by its colon', () => {
    assert.equal(ipVersionOf('[::1]'), 'IPv6')
  })
})

describe('parseLsofStream', () => {
  // The exact field stream `lsof -nP -a -iTCP -sTCP:LISTEN -F pcLnPTu` emits.
  const sample = [
    'p518',
    'crapportd',
    'u501',
    'Lwungjyan',
    'f11',
    'PTCP',
    'n*:63431',
    'TST=LISTEN',
    'TQR=0',
    'TQS=0',
    'f14',
    'PTCP',
    'n*:63431',
    'TST=LISTEN',
    'TQR=0',
    'TQS=0',
    'p547',
    'cControlCenter',
    'u501',
    'Lwungjyan',
    'f9',
    'PTCP',
    'n*:7000',
    'TST=LISTEN',
    '',
  ].join('\n')

  test('extracts one record per unique bound address', () => {
    const records = parseLsofStream(sample)
    assert.equal(records.length, 2)
    assert.deepEqual(
      records.map((record) => [record.pid, record.port]),
      [
        [518, 63431],
        [547, 7000],
      ],
    )
  })

  test('carries the process name and user onto each record', () => {
    const [first] = parseLsofStream(sample)
    assert.equal(first.processName, 'rapportd')
    assert.equal(first.user, 'wungjyan')
    assert.equal(first.protocol, 'TCP')
    assert.equal(first.state, 'LISTEN')
  })

  test('collapses the duplicate fd rows lsof reports', () => {
    // Both `f11` and `f14` bind `*:63431` for the same pid; one row must survive.
    const records = parseLsofStream(sample).filter((record) => record.pid === 518)
    assert.equal(records.length, 1)
  })

  test('returns nothing for empty output', () => {
    assert.deepEqual(parseLsofStream(''), [])
  })

  test('ignores an n line that belongs to no pid', () => {
    assert.deepEqual(parseLsofStream('n127.0.0.1:80\n'), [])
  })

  test('defaults a missing protocol to TCP and a missing state to LISTEN', () => {
    const [record] = parseLsofStream('p100\ncnode\nLme\nn127.0.0.1:3000\n')
    assert.equal(record.protocol, 'TCP')
    assert.equal(record.state, 'LISTEN')
  })

  test('groups multiple addresses of one listener into separate records', () => {
    const stdout = 'p9\ncnode\nLme\nn127.0.0.1:3000\nn[::1]:3000\n'
    const records = parseLsofStream(stdout)
    assert.equal(records.length, 2)
    assert.deepEqual(records.map((record) => record.host), ['127.0.0.1', '[::1]'])
  })
})

describe('parseStartTime', () => {
  test('parses an English lstart stamp', () => {
    const parsed = parseStartTime('Thu May 21 14:10:00 2026')
    assert.notEqual(parsed, null)
    assert.equal(parsed.sortable, 20260521141000)
  })

  test('parses a single-digit day padded with a double space', () => {
    const parsed = parseStartTime('Mon Nov  9 09:03:42 2026')
    assert.notEqual(parsed, null)
    assert.equal(parsed.sortable, 20261109090342)
  })

  test('rejects a localized stamp, which is why ps runs under LC_ALL=C', () => {
    // What `LC_ALL=zh_CN.UTF-8 ps -o lstart=` actually prints.
    assert.equal(parseStartTime('四 11月/12 10:44:27 2026'), null)
    // What a German locale prints.
    assert.equal(parseStartTime('Do. 12 Nov. 10:44:27 2026'), null)
  })

  test('rejects an empty value', () => {
    assert.equal(parseStartTime(''), null)
  })

  test('orders two stamps consistently', () => {
    const older = parseStartTime('Mon Nov  9 09:03:42 2026')
    const newer = parseStartTime('Thu Nov 12 10:44:27 2026')
    assert.ok(older.sortable < newer.sortable)
    assert.ok(older.epochMs < newer.epochMs)
  })
})

describe('parsePsLine', () => {
  test('keeps spaces inside the command', () => {
    const parsed = parsePsLine(
      '  518 Mon Nov  9 09:03:42 2026     /usr/libexec/rapportd --flag a b',
    )
    assert.equal(parsed.pid, 518)
    assert.equal(parsed.startedAt, 'Mon Nov 9 09:03:42 2026')
    assert.equal(parsed.command, '/usr/libexec/rapportd --flag a b')
  })

  test('rejects a line that is too short to hold a start time', () => {
    assert.equal(parsePsLine('518 /usr/bin/foo'), null)
  })

  test('rejects an empty line', () => {
    assert.equal(parsePsLine('   '), null)
  })

  test('rejects a non-numeric pid', () => {
    assert.equal(parsePsLine('abc Mon Nov 9 09:03:42 2026 cmd'), null)
  })
})

describe('deriveProcessName', () => {
  test('takes the basename of a plain command', () => {
    assert.equal(deriveProcessName('/opt/homebrew/bin/node index.js'), 'node')
  })

  test('prefers the executable of an app bundle over its arguments', () => {
    assert.equal(
      deriveProcessName(
        "/Applications/X.app/Contents/MacOS/X --type=gpu-process --flag",
      ),
      'X',
    )
  })

  test('handles a command with no path', () => {
    assert.equal(deriveProcessName('python3 -m http.server'), 'python3')
  })

  test('unwraps a quoted Windows path before taking the basename', () => {
    // Splitting on whitespace first reads the executable as `Program`, which is
    // what the row would then call the process.
    assert.equal(
      deriveProcessName('"C:\\Program Files\\nodejs\\node.exe" --inspect=9229'),
      'node.exe',
    )
  })

  test('keeps an unquoted Windows path working', () => {
    assert.equal(
      deriveProcessName('C:\\Windows\\System32\\svchost.exe -k netsvcs -p'),
      'svchost.exe',
    )
  })

  test('takes an unterminated quote to the end rather than dropping it', () => {
    assert.equal(deriveProcessName('"C:\\tools\\a b.exe'), 'a b.exe')
  })

  test('returns nothing when the command line starts with a switch', () => {
    // WSL launches its relay with an empty argv[0]:
    // ` --mode 1 --vm-id {3c9fb2b6-...} --handle 2484`. Reading `--mode` as
    // the program name labelled a Docker row that way on Windows, so the
    // derivation returns nothing and the platform process table names it
    // instead (wslrelay.exe).
    assert.equal(
      deriveProcessName(' --mode 1 --vm-id {3c9fb2b6-f2cc-4353-92d4-154559ed9c98} --handle 2484'),
      '',
    )
    assert.equal(deriveProcessName('--flag=1'), '')
    assert.equal(deriveProcessName('-x'), '')
  })

  test('returns an empty string for an empty command', () => {
    assert.equal(deriveProcessName('   '), '')
  })
})

describe('summarizeHosts', () => {
  test('renders one address with its family', () => {
    assert.equal(summarizeHosts(['127.0.0.1'], ['IPv4']), 'IPv4 · 127.0.0.1')
  })

  test('joins several addresses', () => {
    assert.equal(
      summarizeHosts(['127.0.0.1', '*'], ['IPv4']),
      'IPv4 · 127.0.0.1  |  *',
    )
  })

  test('labels a dual-stack listener', () => {
    assert.equal(summarizeHosts(['*'], ['IPv4', 'IPv6']), 'IPv4 + IPv6 · *')
  })

  test('falls back to a dash when nothing is bound', () => {
    assert.equal(summarizeHosts([], []), '-')
  })
})

describe('matchesQuery', () => {
  const item = {
    pid: 1234,
    processName: 'node',
    command: 'node /proj/node_modules/.bin/vite',
    cwd: '/proj/web',
    port: 5173,
    hosts: ['127.0.0.1'],
  }

  test('matches on the port', () => {
    assert.equal(matchesQuery(item, '5173'), true)
  })

  test('matches on the pid', () => {
    assert.equal(matchesQuery(item, '1234'), true)
  })

  test('matches on the process name', () => {
    assert.equal(matchesQuery(item, 'node'), true)
  })

  test('matches on a directory fragment', () => {
    assert.equal(matchesQuery(item, '/proj'), true)
  })

  test('matches on a bind address', () => {
    assert.equal(matchesQuery(item, '127.0.0.1'), true)
  })

  test('rejects an unrelated keyword', () => {
    assert.equal(matchesQuery(item, 'postgres'), false)
  })

  test('treats a null cwd as empty rather than throwing', () => {
    assert.equal(matchesQuery({ ...item, cwd: null }, 'node'), true)
  })
})
