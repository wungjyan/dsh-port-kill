import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBinary, run } from '../platforms/exec.js'

import {
  backendFor,
  loadBackend,
  UNSUPPORTED_CAPABILITIES,
} from '../platforms/index.js'
import {
  forwardingProxyKind,
  parseCimDate,
  parseNetstat,
  parseProcessJson,
  processFilter,
} from '../platforms/win32.js'
import { capabilities as win32Capabilities } from '../platforms/win32.js'
import { capabilities as posixCapabilities } from '../platforms/posix.js'
import { parseLsofStream } from '../platforms/posix.js'
import { deriveProcessName, ipVersionOf, parseAddress, parseStartTime, summarizeHosts } from '../platforms/parse.js'
import { buildPortMap, isDockerProxy, parseDockerLine, parseDockerPs, parsePortBindings, probeDocker } from '../platforms/docker.js'


describe('backend selection', () => {
  test('maps the supported platforms to their back end', () => {
    assert.equal(backendFor('darwin'), 'posix')
    assert.equal(backendFor('linux'), 'posix')
    assert.equal(backendFor('freebsd'), 'posix')
    assert.equal(backendFor('win32'), 'win32')
  })

  test('maps everything else to unsupported rather than guessing', () => {
    // SunOS and AIX were never verified; silently reusing the POSIX back end
    // would report an empty list as if the machine had no listeners.
    for (const platform of ['sunos', 'aix', 'android', 'openbsd', '']) {
      assert.equal(backendFor(platform), 'unsupported', `${platform} should be unsupported`)
    }
  })

  test('loads a back end for a supported platform', async () => {
    const backend = await loadBackend('linux')
    assert.notEqual(backend, null)
    for (const name of [
      'scanListeners',
      'scanPort',
      'scanPortsForPid',
      'loadProcessInfo',
      'loadWorkingDirectories',
      'ancestorChain',
      'currentUser',
    ]) {
      assert.equal(typeof backend[name], 'function', `${name} should be callable`)
    }
    assert.equal(backend.capabilities.gracefulSignal, true)
  })

  test('returns null for an unsupported platform', async () => {
    assert.equal(await loadBackend('sunos'), null)
  })

  test('the unsupported capability set denies everything', () => {
    assert.equal(UNSUPPORTED_CAPABILITIES.supported, false)
    assert.equal(UNSUPPORTED_CAPABILITIES.gracefulSignal, false)
    assert.equal(UNSUPPORTED_CAPABILITIES.userAttribution, false)
    assert.equal(typeof UNSUPPORTED_CAPABILITIES.reason, 'string')
    assert.ok(UNSUPPORTED_CAPABILITIES.reason.length > 0)
  })
})

describe('capability differences between platforms', () => {
  test('Windows admits it has no catchable signal', async () => {
    // process.kill terminates on Windows either way; claiming a graceful stop
    // would promise the process a chance to save work that it does not get.
    const backend = await loadBackend('win32')
    assert.equal(backend.capabilities.gracefulSignal, false)
  })

  test('Windows admits it cannot read another process working directory', async () => {
    const backend = await loadBackend('win32')
    assert.equal(backend.capabilities.canReadWorkingDirectory, false)
  })

  test('POSIX provides every capability the contract names', async () => {
    const backend = await loadBackend('darwin')
    assert.equal(backend.capabilities.gracefulSignal, true)
    assert.equal(backend.capabilities.canReadWorkingDirectory, true)
    assert.equal(backend.capabilities.userAttribution, true)
  })
})

describe('netstat parsing', () => {
  test('keeps listening sockets and drops established connections', () => {
    // Captured shape: Proto, Local, Foreign, State, PID.
    const output = [
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       8842',
      '  TCP    127.0.0.1:5173         127.0.0.1:52000        ESTABLISHED     8842',
      '  TCP    [::]:445               [::]:0                 LISTENING       4',
    ].join('\r\n')

    const records = parseNetstat(output)
    assert.equal(records.length, 3)
    assert.deepEqual(
      records.map((record) => record.port).sort((left, right) => left - right),
      [135, 445, 5173],
    )
  })

  test('carries the owning pid and address family', () => {
    const records = parseNetstat('  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    8842')
    assert.deepEqual(records, [
      { pid: 8842, port: 5173, host: '127.0.0.1', protocol: 'TCP', state: 'LISTEN', ipVersion: 'IPv4' },
    ])
  })

  test('recognises an IPv6 listener', () => {
    const records = parseNetstat('  TCP    [::]:445    [::]:0    LISTENING    4')
    assert.equal(records.length, 1)
    assert.equal(records[0].ipVersion, 'IPv6')
  })

  test('ignores UDP rows, which have no LISTENING state', () => {
    const records = parseNetstat('  UDP    0.0.0.0:500     *:*                                    1234')
    assert.deepEqual(records, [])
  })

  test('tolerates the header line and blank lines', () => {
    const output = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4',
      '',
    ].join('\r\n')
    const records = parseNetstat(output)
    assert.equal(records.length, 1)
    assert.equal(records[0].port, 80)
  })

  test('drops rows with an unparseable pid', () => {
    assert.deepEqual(parseNetstat('  TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    notanumber'), [])
  })

  test('accepts a build that labels IPv6 sockets TCPv6', () => {
    // The protocol column normally says TCP for both families, but the `-p`
    // filter names the IPv6 family separately, so the label is not guaranteed.
    // Publishing them under one protocol keeps the list from losing every IPv6
    // listener on such a build.
    const records = parseNetstat('  TCPv6    [::]:445    [::]:0    LISTENING    4')
    assert.equal(records.length, 1)
    assert.equal(records[0].protocol, 'TCP')
    assert.equal(records[0].ipVersion, 'IPv6')
  })
})

describe('CIM datetime parsing', () => {
  test('reads the /Date(ms)/ wrapper older builds emit', () => {
    const parsed = parseCimDate('/Date(1700000000000)/')
    assert.notEqual(parsed, null)
    assert.equal(parsed.epochMs, 1_700_000_000_000)
  })

  test('reads an ISO string newer builds emit', () => {
    const parsed = parseCimDate('2026-05-21T14:10:00.000Z')
    assert.notEqual(parsed, null)
    assert.equal(parsed.epochMs, Date.parse('2026-05-21T14:10:00.000Z'))
  })

  test('reads the projected { DateTime } shape', () => {
    const parsed = parseCimDate({ DateTime: '2026-05-21T14:10:00.000Z' })
    assert.notEqual(parsed, null)
    assert.equal(parsed.epochMs, Date.parse('2026-05-21T14:10:00.000Z'))
  })

  test('publishes the same sortable shape POSIX rows carry', () => {
    // One contract across platforms; the UI sorts both with one code path.
    const parsed = parseCimDate('2026-05-21T14:10:00.000Z')
    const date = new Date(Date.parse('2026-05-21T14:10:00.000Z'))
    const expected =
      date.getFullYear() * 10_000_000_000 +
      (date.getMonth() + 1) * 100_000_000 +
      date.getDate() * 1_000_000 +
      date.getHours() * 10_000 +
      date.getMinutes() * 100 +
      date.getSeconds()
    assert.equal(parsed.sortable, expected)
  })

  test('returns null for values it cannot read', () => {
    assert.equal(parseCimDate(null), null)
    assert.equal(parseCimDate(undefined), null)
    assert.equal(parseCimDate('not a date'), null)
    assert.equal(parseCimDate({}), null)
  })

  test('reads a wrapper that carries a timezone offset', () => {
    // Some builds emit `/Date(ms+0800)/`. The milliseconds are the instant
    // either way; rejecting the suffix would make every kill on that build
    // refuse for want of a start time.
    const parsed = parseCimDate('/Date(1700000000000+0800)/')
    assert.notEqual(parsed, null)
    assert.equal(parsed.epochMs, 1_700_000_000_000)
  })

  test('reads an ISO stamp with sub-millisecond digits', () => {
    // PowerShell 7 writes seven fractional digits, one more than ECMAScript
    // specifies. The extra digits are truncated rather than treated as invalid.
    const parsed = parseCimDate('2026-05-21T14:10:00.1234567+08:00')
    assert.notEqual(parsed, null)
    assert.equal(parsed.epochMs, Date.parse('2026-05-21T14:10:00.123+08:00'))
  })
})

describe('process JSON parsing', () => {
  test('reads a single object, which PowerShell emits for one match', () => {
    // ConvertTo-Json unwraps a one-element array; iterating it as an array would
    // throw, so this shape has to be handled explicitly.
    const parsed = parseProcessJson(
      JSON.stringify({ ProcessId: 8842, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node index.js' }),
    )
    assert.equal(parsed.size, 1)
    assert.equal(parsed.get(8842).command, 'node index.js')
  })

  test('reads an array of processes', () => {
    const parsed = parseProcessJson(
      JSON.stringify([
        { ProcessId: 10, Name: 'a.exe', CommandLine: 'a' },
        { ProcessId: 20, Name: 'b.exe', CommandLine: 'b' },
      ]),
    )
    assert.equal(parsed.size, 2)
    assert.equal(parsed.get(20).command, 'b')
  })

  test('carries the parent pid the self-protection walk needs', () => {
    const parsed = parseProcessJson(JSON.stringify({ ProcessId: 5, ParentProcessId: 4 }))
    assert.equal(parsed.get(5).parentPid, 4)
  })

  test('tolerates malformed JSON rather than throwing', () => {
    assert.equal(parseProcessJson('not json').size, 0)
    assert.equal(parseProcessJson('').size, 0)
  })

  test('skips rows without a usable pid', () => {
    const parsed = parseProcessJson(JSON.stringify([{ Name: 'no-pid' }, { ProcessId: 7 }]))
    assert.equal(parsed.size, 1)
    assert.ok(parsed.has(7))
  })
})

describe('shared parsers serve every platform', () => {
  test('an lsof address and a netstat address parse the same way', () => {
    // Both feed the same aggregator, so the shape must agree.
    assert.deepEqual(parseAddress('127.0.0.1:5173'), { host: '127.0.0.1', port: 5173 })
    assert.deepEqual(parseAddress('*:8080'), { host: '*', port: 8080 })
  })

  test('derives an IPv4 family for a wildcard bind on both platforms', () => {
    assert.equal(ipVersionOf('0.0.0.0'), 'IPv4')
    assert.equal(ipVersionOf('*'), 'IPv4')
    assert.equal(ipVersionOf('[::]'), 'IPv6')
  })

  test('summarizes a dual-stack listener once', () => {
    assert.equal(summarizeHosts(['*'], ['IPv4', 'IPv6']), 'IPv4 + IPv6 · *')
  })

  test('the POSIX parser still reads its own stream', () => {
    // The split must not have changed what macOS does today.
    const records = parseLsofStream('p123\ncnode\nLme\nPTCP\nTST=LISTEN\nn127.0.0.1:5173\n')
    assert.equal(records.length, 1)
    assert.equal(records[0].port, 5173)
  })
})

describe('docker attribution', () => {
  test('reads a tab-separated container line', () => {
    const parsed = parseDockerLine(
      'smartagri-mysql\tmysql:8.0\t0.0.0.0:3306->3306/tcp\tsmartagri-ai\tmysql',
    )
    assert.equal(parsed.name, 'smartagri-mysql')
    assert.equal(parsed.image, 'mysql:8.0')
    assert.equal(parsed.project, 'smartagri-ai')
    assert.equal(parsed.service, 'mysql')
    assert.deepEqual(parsed.ports, [
      { hostPort: 3306, containerPort: 3306, hostIp: '0.0.0.0', protocol: 'tcp' },
    ])
  })

  test('reports both halves of a dual-stack binding', () => {
    // Docker prints `0.0.0.0:3306->3306/tcp, :::3306->3306/tcp`. These are two
    // distinct binds and both are reported, but they collapse to one host port
    // in the lookup, which is what a row is keyed on.
    const ports = parsePortBindings('0.0.0.0:3306->3306/tcp, :::3306->3306/tcp')
    assert.equal(ports.length, 2)
    assert.deepEqual(
      ports.map((port) => port.hostPort),
      [3306, 3306],
    )
    assert.equal(buildPortMap([{ name: 'x', image: '', project: '', service: '', ports }]).size, 1)
  })

  test('reads a specific bind address and an ephemeral host port', () => {
    assert.deepEqual(parsePortBindings('127.0.0.1:8080->80/tcp'), [
      { hostPort: 8080, containerPort: 80, hostIp: '127.0.0.1', protocol: 'tcp' },
    ])
    assert.equal(parsePortBindings('0.0.0.0:32768->5432/tcp')[0].hostPort, 32768)
  })

  test('ignores an exposed but unpublished port', () => {
    // `80/tcp` has no `->`, so it holds no host port and must not be attributed.
    assert.deepEqual(parsePortBindings('80/tcp'), [])
  })

  test('pairs a published port range', () => {
    const ports = parsePortBindings('0.0.0.0:5000-5002->6000-6002/tcp')
    assert.deepEqual(
      ports.map((port) => [port.hostPort, port.containerPort]),
      [
        [5000, 6000],
        [5001, 6001],
        [5002, 6002],
      ],
    )
  })

  test('rejects a pathological range rather than allocating it', () => {
    assert.deepEqual(parsePortBindings('0.0.0.0:1-65000->1-65000/tcp'), [])
  })

  test('maps a host port to its container', () => {
    const map = buildPortMap(
      parseDockerPs(
        [
          'a\timg:1\t0.0.0.0:3306->3306/tcp\tproj\ta',
          'b\timg:2\t0.0.0.0:6379->6379/tcp\tproj\tb',
        ].join('\n'),
      ),
    )
    assert.equal(map.get(3306).name, 'a')
    assert.equal(map.get(6379).name, 'b')
    assert.equal(map.get(9999), undefined)
  })

  test('recognises the names Docker proxies run under', () => {
    for (const name of ['com.docker.backend', 'docker-proxy', 'vpnkit', 'com.docker.vpnkit']) {
      assert.equal(isDockerProxy(name), true, `${name} should be recognised`)
    }
    for (const name of ['node', 'java', 'com.docker.build', '']) {
      assert.equal(isDockerProxy(name), false, `${name} should not be recognised`)
    }
  })

  test('a missing docker binary is not an error', () => {
    // Attribution is an enhancement: the port list must survive with no Docker.
    return probeDocker().then((result) => {
      assert.equal(typeof result.available, 'boolean')
      assert.ok(result.ports instanceof Map)
    })
  })
})

describe('Windows process query', () => {
  test('selects one pid by equality', () => {
    assert.equal(processFilter([8842]), 'ProcessId=8842')
  })

  test('chains equality with OR rather than using IN', () => {
    // WQL has no `IN` operator. `ProcessId IN (1,2)` fails the whole query, and
    // a failed query returns no start time, which refuses every kill.
    const filter = processFilter([10, 20, 30])
    assert.equal(filter, 'ProcessId=10 OR ProcessId=20 OR ProcessId=30')
    assert.equal(/\bIN\b/.test(filter), false)
  })
})

describe('Windows forwarding relays', () => {
  test('recognises the WSL loopback relay', () => {
    // Measured on Windows 11 + Docker Desktop: a published container port is
    // held twice, `com.docker.backend.exe` on 0.0.0.0 and `wslrelay.exe` on
    // [::1]. Ending the relay only breaks forwarding, so it is refused.
    assert.equal(forwardingProxyKind('wslrelay.exe'), 'wsl')
    assert.equal(forwardingProxyKind('wslhost.exe'), 'wsl')
  })

  test('leaves Docker names to the Docker proxy check', () => {
    // `isDockerProxy` owns those names on every platform; a second owner would
    // make the dialog pick the wrong sentence.
    for (const name of ['com.docker.backend.exe', 'docker-proxy', 'vpnkit', 'node.exe', '--mode', '']) {
      assert.equal(forwardingProxyKind(name), null, `${name} should not be a WSL relay`)
    }
  })
})

describe('platform capability flags', () => {
  test('POSIX attributes every field the identity check compares', () => {
    assert.equal(posixCapabilities.gracefulSignal, true)
    assert.equal(posixCapabilities.userAttribution, true)
    assert.equal(posixCapabilities.nameAttribution, true)
  })

  test('Windows declares the fields netstat cannot supply', () => {
    // These are not cosmetic: identity verification reads them to decide which
    // comparisons it can make. Claiming true would refuse every kill with
    // "the process changed" on a process that never changed.
    assert.equal(win32Capabilities.supported, true)
    assert.equal(win32Capabilities.gracefulSignal, false)
    assert.equal(win32Capabilities.userAttribution, false)
    assert.equal(win32Capabilities.nameAttribution, false)
  })

  test('only Windows requires a provable ancestor chain', () => {
    // The host refuses a kill when the parent map cannot be read, but only
    // where the platform says the read is required: macOS and Linux keep
    // walking whatever they can, exactly as before.
    assert.equal(win32Capabilities.ancestorChainRequired, true)
    assert.equal(posixCapabilities.ancestorChainRequired, undefined)
  })

  test('the unsupported platform claims nothing', () => {
    for (const flag of ['supported', 'gracefulSignal', 'userAttribution', 'nameAttribution', 'canReadWorkingDirectory']) {
      assert.equal(UNSUPPORTED_CAPABILITIES[flag], false, `${flag} should be false`)
    }
    assert.equal(typeof UNSUPPORTED_CAPABILITIES.reason, 'string')
  })
})

describe('start-time contract across platforms', () => {
  test('a Windows start time reads as the same string POSIX prints', () => {
    const parsed = parseCimDate('2026-05-21T14:10:00.000Z')
    // Same shape `ps -o lstart` produces under LC_ALL=C: weekday, month,
    // space-padded day, local time, year.
    assert.match(parsed.text, /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/)
  })

  test('the POSIX parser accepts what the Windows back end publishes', () => {
    // One contract, two producers. If these ever drift the column would show two
    // different formats depending on the machine, which is what this catches.
    const parsed = parseCimDate('2026-05-21T14:10:00.000Z')
    const round = parseStartTime(parsed.text)
    assert.notEqual(round, null)
    assert.equal(round.sortable, parsed.sortable)
    // lstart has no sub-second field, so the comparison is to the second.
    assert.equal(round.epochMs, Math.floor(parsed.epochMs / 1000) * 1000)
  })
})

describe('finding a system binary', () => {
  test('takes the first candidate that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-bin-'))
    try {
      const real = join(dir, 'lsof')
      writeFileSync(real, '')
      // A missing candidate before an existing one must not stop the search:
      // the whole point is that the layout differs per distribution.
      assert.equal(resolveBinary(['/nope/first', real, '/nope/last'], 'lsof'), real)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('falls back to the bare name so PATH still gets a say', () => {
    assert.equal(resolveBinary(['/nope/a', '/nope/b'], 'lsof'), 'lsof')
  })
})

describe('how a failed command is reported', () => {
  test('a missing binary is missing, not a timeout', async () => {
    // The two used to collapse into one message: a spawn failure carries
    // `signal: undefined`, which an `!== null` test read as "killed by a
    // signal". Ubuntu shipped without /usr/sbin/lsof and the report said
    // "timed out", which sent the search to the wrong place entirely.
    await assert.rejects(
      run('/nonexistent/lsof-binary', [], { timeoutMs: 1_000 }),
      (error) => /找不到可执行文件/.test(error.message) && !/超时/.test(error.message),
    )
  })

  test('a command that outlives its ceiling is a timeout', async () => {
    await assert.rejects(
      run(process.execPath, ['-e', 'setTimeout(function () {}, 5000)'], { timeoutMs: 200 }),
      (error) => /超时/.test(error.message),
    )
  })
})
