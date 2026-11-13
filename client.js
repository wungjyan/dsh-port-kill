/**
 * Port Kill — Client half.
 *
 * A full-page panel in the frame's central column, opened from one icon in the
 * left sidebar rail. The panel lists every TCP port this machine is listening
 * on, shows which process behind each one, and can end that process — after the
 * Host half re-verifies it is still the same process the user was shown.
 *
 * ## Where it renders, and why
 *
 * `main` is the frame's keyed central slot: the Conversation holds the reserved
 * `conversation` key, the shipped Plugins and Schedules pages hold their own, and
 * any other key renders as one more full page. Pairing it with a
 * `sidebar.panellist` entry of the same id is what makes it reachable — the
 * sidebar owns the button, this file owns the page. `scope: 'root'` means the
 * page does not depend on a Session being open.
 *
 * The right sidebar (`ctx.sidebarRightTabs`) was the alternative and was
 * rejected: it only exists while a Session is selected, and a port conflict is
 * not a per-conversation problem.
 *
 * ## Plain JavaScript, no build step
 *
 * The browser module table exposes `react` and nothing else this file needs, so
 * every element is built with `React.createElement` and the stylesheet is one
 * owned `<style>` element. There is no JSX transform, no bundler, and no
 * dependency on any Harness Client package — those change without notice and a
 * thrown render blanks the whole slot entry.
 *
 * ## Theme
 *
 * Every colour is a `--dsw-alias-*` token. The theme service publishes them on
 * `body` and re-publishes under `body[data-ds-dark-theme]`, so light/dark
 * switching needs no code here at all — as long as nothing is hard-coded.
 */
window.__ModuleLoader__.load({
  id: '@wungjyan/dsh-port-kill',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** This plugin's namespace: the locale dictionary key and the panel key. */
    const NS = 'dsh-port-kill'

    /** The npm package name: the key the Plugins page uses for this bundle. */
    const PACKAGE_NAME = '@wungjyan/dsh-port-kill'

    /** Sidebar id and `main` key are the same value; the sidebar resolves one from the other. */
    const PANEL_ID = 'port-kill'

    /** Host routes, registered in host.js. */
    const PORTS_PATH = '/port-kill/ports'
    const KILL_PATH = '/port-kill/kill'
    const REBOUND_PATH = '/port-kill/rebound'
    const SETTINGS_PATH = '/port-kill/settings'

    /** Settings this build understands. The Host validates the same lists. */
    const DEFAULT_REFRESH_MS = 10_000
    const DEFAULT_NAV_LABEL = 'auto'
    /** The refresh cadences the Host accepts, in milliseconds. `0` means off. */
    // Written out rather than derived from the number: the dictionary-completeness
    // test only reads literal translate calls, so a computed key would look unused.
    const REFRESH_CHOICES = [
      { value: 0, key: 'refreshOff' },
      { value: 3_000, key: 'refresh3s' },
      { value: 5_000, key: 'refresh5s' },
      { value: 10_000, key: 'refresh10s' },
      { value: 15_000, key: 'refresh15s' },
      { value: 30_000, key: 'refresh30s' },
      { value: 60_000, key: 'refresh60s' },
    ]
    /** How the sidebar label resolves; `auto` follows the interface language. */
    const NAV_LABEL_CHOICES = ['auto', 'zh', 'en']

    /** Wait this long after a kill before asking whether the port came back. */
    const REBOUND_DELAY_MS = 900

    /**
     * The settings the Host owns, mirrored for this page.
     *
     * Held in a module-level store rather than in component state because two
     * unrelated places read it: the panel's refresh loop and the sidebar label.
     * The Host is the source of truth; this is the last value it confirmed.
     */
    const settingsStore = {
      current: { refreshMs: DEFAULT_REFRESH_MS, navLabel: DEFAULT_NAV_LABEL },
      listeners: new Set(),
      loaded: false,
    }

    /**
     * Publish a confirmed settings document to every subscriber.
     * @param {object} next - the complete document.
     */
    function publishSettings(next) {
      settingsStore.current = next
      settingsStore.loaded = true
      for (const listener of settingsStore.listeners) listener(next)
    }

    /**
     * Subscribe to settings changes.
     * @param {(settings: object) => void} listener - called on every change.
     * @returns {() => void} unsubscribe.
     */
    function subscribeSettings(listener) {
      settingsStore.listeners.add(listener)
      return () => {
        settingsStore.listeners.delete(listener)
      }
    }

    /**
     * Read the settings once from the Host.
     *
     * A failure leaves the defaults in place: a page that cannot reach its own
     * settings should still show ports, and the refresh control simply shows the
     * default until the Host answers.
     * @returns {Promise<void>} resolution after the read settles.
     */
    async function loadSettings() {
      try {
        const response = await fetch(SETTINGS_PATH, {
          cache: 'no-store',
          credentials: 'same-origin',
        })
        if (!response.ok) return
        const body = await response.json()
        if (body?.settings !== null && typeof body?.settings === 'object') {
          publishSettings(body.settings)
        }
      } catch {
        // Settings are an enhancement; losing them must not break the page.
      }
    }

    /**
     * Persist a partial settings change.
     *
     * The Host validates and echoes the merged document, so the store always
     * holds what is actually on disk rather than what this page hoped for.
     * @param {object} patch - the fields to change.
     * @returns {Promise<object | null>} the confirmed document, or null on failure.
     */
    async function saveSettings(patch) {
      try {
        const response = await fetch(SETTINGS_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || body?.settings === null || typeof body?.settings !== 'object') {
          return null
        }
        publishSettings(body.settings)
        return body.settings
      } catch {
        return null
      }
    }

    /**
     * Which dictionary the sidebar label should read.
     *
     * `auto` follows the interface language; the fixed modes exist because a
     * user may prefer an English plugin name inside a Chinese interface.
     * @param {object} settings - the confirmed settings.
     * @param {string} localeId - the active interface language.
     * @returns {'zh' | 'en'} the label language.
     */
    function navLabelLanguage(settings, localeId) {
      const mode = settings !== null && typeof settings === 'object' ? settings.navLabel : 'auto'
      if (mode === 'zh' || mode === 'en') return mode
      return String(localeId ?? '').startsWith('zh') ? 'zh' : 'en'
    }

    /** Copy. Kept in-file so the page needs no locale round-trip to render. */
    const DICT = {
      zh: {
        'nav': '端口管理',
        'title': '端口管理',
        'subtitle': '本机 TCP 监听端口与占用它的进程',
        'search': '搜索端口 / 进程 / PID / 命令 / 目录',
        'refresh': '刷新',
        'refreshing': '扫描中',
        'updated': '已更新',
        'failed': '刷新失败',
        'never': '尚未扫描',
        'total': '共 {n} 个端口',
        'filtered': '显示 {shown} / {total}',
        'settingsTitle': '设置',
        'settingsHint': '这些设置保存在本机，重启后仍然生效。自动刷新间隔在面板顶部的工具栏上调整。',
        'settingsNavLabel': '侧边栏名称',
        'settingsNavLabelHint': '侧边栏和页面标题显示的名称。默认跟随界面语言。',
        'navLabelAuto': '跟随界面语言',
        'navLabelZh': '固定中文（端口管理）',
        'navLabelEn': '固定英文（Port Kill）',
        'settingsSaveFailed': '设置保存失败',
        'autoRefresh': '自动刷新',
        'refreshOff': '关闭',
        'refresh3s': '3 秒',
        'refresh5s': '5 秒',
        'refresh10s': '10 秒',
        'refresh15s': '15 秒',
        'refresh30s': '30 秒',
        'refresh60s': '60 秒',
        'colPort': '端口',
        'colProcess': '进程',
        'colPid': 'PID',
        'colAddress': '地址',
        'colStarted': '启动时间',
        'colActions': '操作',
        'empty': '没有监听的端口。',
        'scanFailed': '无法读取端口列表，见上方错误信息。',
        'emptyFiltered': '没有匹配的端口。',
        'loading': '正在扫描端口…',
        'kill': '结束',
        'killing': '结束中',
        'expand': '展开详情',
        'collapse': '收起详情',
        'detailCommand': '命令',
        'detailCwd': '工作目录',
        'detailHosts': '监听地址',
        'detailUser': '用户',
        'detailProto': '协议 / 状态',
        'detailContainer': 'Docker 容器',
        'detailStarted': '启动时间',
        'unavailable': '不可用',
        'unknown': '未知',
        'retry': '重试',
        'dockerContainer': "容器：{name}",
        'dockerImage': "镜像：{image}",
        'dockerImageLabel': "镜像",
        'dockerProject': "compose 项目：{project}",
        'dockerProjectLabel': "compose 项目",
        'dockerMapping': "端口映射：宿主机 {host} → 容器 {inner}",
        'dockerNoKill': "这是 Docker 的端口转发进程，不是容器本身。在这里结束它不会停止容器，只会中断转发并影响其它已发布端口。请打开 Docker Desktop 停止容器「{name}」。",
        'dockerNoKillUnknown': "这是 Docker 的端口转发进程，不是容器本身。在这里结束它不会停止容器，只会中断转发。请打开 Docker Desktop 停止对应容器。",
        'dockerUnavailable': "Docker 不可用，无法确认这个端口背后的容器",
        'dockerBlockedTitle': "这个端口不能在这里结束",
        'dockerBlockedBody': "端口 :{port} 由 Docker 的端口转发进程「{name}」（PID {pid}）持有，容器本身运行在 Docker 里。",
        'dismiss': "知道了",
        'exposureWide': "局域网可访问",
        'exposureWideHint': "这个端口监听在 {hosts}，同一局域网内的其它设备可以直接连接它。只想本机使用的话，把服务改成监听 127.0.0.1。",
        'exposureLocal': "仅本机",
        'exposureLimited': "指定地址",
        'killTitle': "结束进程",
        'killBody': "占用端口 :{port} 的进程是「{name}」（PID {pid}）。结束进程不可撤销。",
        'killMultiPort': "该进程同时监听 {n} 个端口，结束它会把这 {n} 个端口一起释放：",
        'killMultiPortNote': "结束的是进程，不是单个端口——信号无法只关闭其中一个。",
        'killHint': "「结束」让进程自己退出，它有机会先保存数据；「强制结束」直接杀死进程，未保存的数据会丢失。",
        'killHintNoGraceful': "当前平台没有可捕获的退出信号：「结束」和「强制结束」都会直接终止进程，未保存的数据会丢失。",
        'killConfirm': "结束",
        'killConfirmHint': "向进程发送 SIGTERM：进程可以捕获它，先保存数据再退出",
        'killForce': "强制结束",
        'killForceHint': "向进程发送 SIGKILL：进程无法捕获，未保存的数据会丢失",
        'killed': "已结束",
        'killedMultiPort': "已结束，{n} 个端口一并释放",
        'cancel': "取消",
        'limitNote': '只列出当前用户可见的监听端口；其它用户的进程需要更高权限。',
      },
      en: {
        'nav': 'Port Kill',
        'title': 'Port Kill',
        'subtitle': 'TCP ports this machine listens on, and the process behind each one',
        'search': 'Search port / process / PID / command / directory',
        'refresh': 'Refresh',
        'refreshing': 'Scanning',
        'updated': 'Updated',
        'failed': 'Refresh failed',
        'never': 'Not scanned yet',
        'total': '{n} listening ports',
        'filtered': 'Showing {shown} / {total}',
        'settingsTitle': 'Settings',
        'settingsHint': 'Stored on this machine, so they survive a restart. The auto-refresh interval is on the panel toolbar.',
        'settingsNavLabel': 'Sidebar label',
        'settingsNavLabelHint': 'The name shown in the sidebar and as the page title. Follows the interface language by default.',
        'navLabelAuto': 'Follow interface language',
        'navLabelZh': 'Always Chinese (端口管理)',
        'navLabelEn': 'Always English (Port Kill)',
        'settingsSaveFailed': 'Could not save the setting',
        'autoRefresh': 'Auto-refresh',
        'refreshOff': 'Off',
        'refresh3s': '3s',
        'refresh5s': '5s',
        'refresh10s': '10s',
        'refresh15s': '15s',
        'refresh30s': '30s',
        'refresh60s': '60s',
        'colPort': 'Port',
        'colProcess': 'Process',
        'colPid': 'PID',
        'colAddress': 'Address',
        'colStarted': 'Started',
        'colActions': 'Actions',
        'empty': 'Nothing is listening.',
        'scanFailed': 'Could not read the port list — see the error above.',
        'emptyFiltered': 'No matching ports.',
        'loading': 'Scanning ports…',
        'kill': 'End',
        'killing': 'Ending',
        'expand': 'Show details',
        'collapse': 'Hide details',
        'detailCommand': 'Command',
        'detailCwd': 'Directory',
        'detailHosts': 'Addresses',
        'detailUser': 'User',
        'detailProto': 'Protocol / state',
        'detailContainer': 'Docker container',
        'detailStarted': 'Started',
        'unavailable': 'unavailable',
        'unknown': 'unknown',
        'retry': 'Retry',
        'dockerContainer': "Container: {name}",
        'dockerImage': "Image: {image}",
        'dockerImageLabel': "Image",
        'dockerProject': "Compose project: {project}",
        'dockerProjectLabel': "Compose project",
        'dockerMapping': "Port mapping: host {host} → container {inner}",
        'dockerNoKill': "This is Docker's port-forwarding process, not the container. Ending it will not stop the container — it breaks forwarding and affects its other published ports. Stop the container «{name}» in Docker Desktop instead.",
        'dockerNoKillUnknown': "This is Docker's port-forwarding process, not the container. Ending it will not stop the container — it breaks forwarding. Stop the container in Docker Desktop instead.",
        'dockerUnavailable': "Docker is unavailable, so the container behind this port cannot be confirmed",
        'dockerBlockedTitle': "This port cannot be ended here",
        'dockerBlockedBody': "Port :{port} is held by Docker's port-forwarding process «{name}» (PID {pid}); the container itself runs inside Docker.",
        'dismiss': "Got it",
        'exposureWide': "Reachable on LAN",
        'exposureWideHint': "This port listens on {hosts}, so other devices on the same network can connect to it. To keep it local, make the server listen on 127.0.0.1.",
        'exposureLocal': "Loopback only",
        'exposureLimited': "Specific address",
        'killTitle': "End process",
        'killBody': "Port :{port} is held by «{name}» (PID {pid}). Ending a process cannot be undone.",
        'killMultiPort': "This process listens on {n} ports. Ending it releases all {n} of them:",
        'killMultiPortNote': "The process is what gets ended, not one port — a signal cannot close just one.",
        'killHint': "«End» lets the process shut down on its own so it can save its work; «Force end» kills it on the spot and unsaved work is lost.",
        'killHintNoGraceful': "This platform has no catchable exit signal: both buttons terminate the process outright, and unsaved work is lost.",
        'killConfirm': "End",
        'killConfirmHint': "Sends SIGTERM: the process can catch it, save its work and exit",
        'killForce': "Force end",
        'killForceHint': "Sends SIGKILL: the process cannot catch it, so unsaved work is lost",
        'killed': "Ended",
        'killedMultiPort': "Ended — {n} ports released",
        'cancel': "Cancel",
        'limitNote': 'Only listeners owned by the current user are visible; other users need higher privileges.',
      },
    }

    /**
     * Fill `{name}` placeholders in one dictionary string.
     * @param {string} template - the string.
     * @param {Record<string, string | number>} values - substitutions.
     * @returns {string} the filled string.
     */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      )
    }

    /**
     * Every port one process is listening on.
     *
     * A signal is addressed to the process, not to a socket, so one kill can
     * close several ports. Falling back to the row's own port keeps the dialog
     * honest when the grouping is missing: it then claims exactly what the row
     * showed, which is never an understatement of the visible target.
     * @param {Record<string, number[]>} portsByPid - the published grouping.
     * @param {{ pid: number, port: number }} row - the row being ended.
     * @returns {number[]} the affected ports, ascending.
     */
    function affectedPortsOf(portsByPid, row) {
      const grouped = portsByPid?.[String(row.pid)]
      if (!Array.isArray(grouped) || grouped.length === 0) return [row.port]
      return grouped.includes(row.port) ? grouped : [row.port, ...grouped].sort((a, b) => a - b)
    }

    /**
     * Describe how widely a listener is exposed.
     *
     * This is the one thing a port list must make obvious: a server on `*` is
     * reachable from the network, one on `127.0.0.1` is not.
     * @param {readonly string[]} hosts - bound addresses.
     * @returns {{ key: string, tone: string }} the label key and its tone.
     */
    function exposureOf(hosts) {
      const normalized = hosts.map((host) => String(host).toLowerCase())

      // A wildcard bind accepts connections from anywhere the machine can be
      // reached — the one case a user needs to notice.
      const allInterfaces = normalized.some((host) =>
        ['*', '0.0.0.0', '[::]', '::'].includes(host),
      )
      if (allInterfaces) return { key: 'exposureWide', wide: true }

      const loopbackOnly =
        normalized.length > 0 &&
        normalized.every((host) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host))
      if (loopbackOnly) return { key: 'exposureLocal', wide: false }

      // A single named interface is still only reachable from the local network,
      // not the internet, so it is not marked wide.
      return { key: 'exposureLimited', wide: false }
    }

    /**
     * The second line of a row's process cell: where the process is working.
     *
     * Ported from the original's `formatProcessMeta`, and for good reason — a
     * full path is mostly boilerplate. The home directory collapses to `~`, a
     * path under it keeps its own tail, and anything outside home keeps only the
     * last two segments. When the directory could not be read the command line is
     * shown instead, which still says what the process is.
     *
     * The home directory is derived from `currentUser` rather than assumed to be
     * `/Users/<name>`: on Linux it is `/home/<name>`, and on Windows the path
     * uses backslashes.
     * @param {object} item - the aggregated row.
     * @param {string} currentUser - the logged-in account.
     * @returns {string} the display text, always non-empty.
     */
    function processMeta(item, currentUser) {
      const raw = typeof item.cwd === 'string' ? item.cwd : ''
      if (raw === '') return item.command || item.processName || ''

      // Windows reports backslashes; the tail-splitting below is written for
      // forward slashes, so normalize first and compare in that form.
      const normalized = raw.replace(/\\/g, '/')

      const user = typeof currentUser === 'string' ? currentUser : ''
      if (user !== '') {
        for (const home of [`/Users/${user}`, `/home/${user}`, `C:/Users/${user}`]) {
          if (normalized === home) return '~'
          if (normalized.startsWith(`${home}/`)) {
            const rest = normalized.slice(home.length + 1)
            return rest === '' ? '~' : `~/${rest}`
          }
        }
      }

      const parts = normalized.split('/').filter(Boolean)
      // A process whose cwd is the filesystem root says nothing useful — many
      // macOS apps launch from `/`. The binary path is the most useful thing
      // left, but a full command line with arguments would be a wall of text in
      // a one-line cell, so the executable is preferred over the whole line.
      if (parts.length === 0) {
        return executableOf(item.command) || item.processName || raw
      }
      if (parts.length <= 2) return `/${parts.join('/')}`
      return `…/${parts.slice(-2).join('/')}`
    }

    /**
     * Why a Docker-proxy row without a container cannot be ended.
     *
     * The two cases read differently on purpose: "Docker is unavailable" explains
     * why nothing could be attributed, while "this is the proxy" explains what the
     * process is. Saying the wrong one sends the user looking in the wrong place.
     * @param {object | null} capabilities - the published platform flags.
     * @param {Function} t - the translator.
     * @returns {string} the explanation.
     */
    function dockerProxyReason(capabilities, t) {
      if (capabilities !== null && capabilities.docker === false) return t('dockerUnavailable')
      return t('dockerNoKillUnknown')
    }

    /**
     * The hover text for a row's Docker badge.
     *
     * Names the compose project and the port mapping, because "which MySQL is
     * this" is usually answered by the project rather than the image tag.
     * @param {object} container - the container attribution.
     * @param {number} hostPort - the host port this row is about.
     * @param {Function} t - the translator.
     * @returns {string} the title text.
     */
    function dockerTitle(container, hostPort, t) {
      const parts = [format(t('dockerContainer'), { name: container.name })]
      if (typeof container.image === 'string' && container.image !== '') {
        parts.push(format(t('dockerImage'), { image: container.image }))
      }
      if (typeof container.project === 'string' && container.project !== '') {
        parts.push(format(t('dockerProject'), { project: container.project }))
      }
      if (container.containerPort !== null && container.containerPort !== undefined) {
        parts.push(
          format(t('dockerMapping'), {
            host: hostPort,
            inner: container.containerPort,
          }),
        )
      }
      return parts.join('\n')
    }

    /**
     * The executable path from a command line, without its arguments.
     *
     * A `.app` bundle's binary path is enough to identify it, and the arguments
     * (which can run to hundreds of characters) would overflow a one-line cell.
     * @param {string} command - the full command line.
     * @returns {string} the executable, or an empty string.
     */
    function executableOf(command) {
      const text = typeof command === 'string' ? command.trim() : ''
      if (text === '') return ''
      // A `.app` launch path contains no spaces up to the binary, so slicing at
      // the first space keeps the whole bundle path intact; anything else is a
      // plain `exe arg arg` line where the first token is the binary.
      return text.split(/\s+/)[0]
    }

    /**
     * Shorten a `ps lstart` stamp to `MM-DD HH:MM`.
     * @param {string | null} value - e.g. `Thu May 21 14:10:00 2026`.
     * @param {(key: string) => string} t - translator, for the unknown fallback.
     * @returns {string} the short stamp.
     */
    function shortStartedAt(value, t) {
      if (value === null || value === undefined || value === '') return t('unknown')
      const parts = value.trim().split(/\s+/)
      if (parts.length < 5) return value
      const months = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
      }
      const month = months[parts[1]]
      if (month === undefined) return value
      const day = parts[2].padStart(2, '0')
      const time = parts[3].slice(0, 5)
      return `${month}-${day} ${time}`
    }

    /** The panel's stylesheet: theme tokens only, no literal colours. */
    const CSS = `
.pk-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;
  padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 0 0;color:var(--dsw-alias-label-primary);
  font-size:var(--dsh-content-font-size,14px)}
.pk-inner{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;box-sizing:border-box;
  padding-left:clamp(16px,2.2vw,32px);padding-right:clamp(16px,2.2vw,32px)}
.pk-head{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;flex:none;padding-bottom:12px}
.pk-headText{display:flex;flex-direction:column;gap:2px;margin-right:auto;min-width:0}
.pk-title{margin:0;font-size:20px;line-height:28px;font-weight:600}
.pk-subtitle{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.pk-toolbar{display:flex;align-items:center;gap:8px;flex:none;padding:0 0 10px}
.pk-search{position:relative;flex:1;min-width:180px}
.pk-searchInput{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.pk-searchInput::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.pk-searchInput:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:transparent}
.pk-btn{flex:none;height:32px;padding:0 12px;border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.pk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pk-btn:disabled{opacity:.5;cursor:default}
.pk-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pk-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.pk-btn--danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.pk-btn--primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.pk-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.pk-select{flex:none;height:32px;padding:0 8px;border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.pk-meta{display:flex;align-items:center;gap:12px;flex:none;padding-bottom:8px;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex-wrap:wrap}
.pk-meta strong{color:var(--dsw-alias-label-primary);font-weight:600}
.pk-error{flex:none;margin-bottom:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);
  background:var(--dsw-alias-bg-layer-1);font-size:13px;display:flex;gap:8px;align-items:center}
.pk-error button{margin-left:auto}
.pk-tableWrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1)}
.pk-table{width:100%;min-width:680px;border-collapse:separate;border-spacing:0;font-size:13px;table-layout:fixed}
.pk-th{position:sticky;top:0;z-index:1;text-align:left;font-weight:600;font-size:12px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l2);padding:0;white-space:nowrap}
.pk-thButton{display:flex;align-items:center;gap:4px;width:100%;padding:9px 12px;border:0;
  background:none;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-align:left}
.pk-thButton:hover{color:var(--dsw-alias-label-primary)}
.pk-thStatic{display:block;padding:9px 12px}
.pk-sortMark{color:var(--dsw-alias-brand-primary);font-size:10px;line-height:1}
.pk-td{padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.pk-row:hover .pk-td{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pk-row:last-child .pk-td{border-bottom:0}
.pk-port{font-variant-numeric:tabular-nums;font-weight:600;font-size:13px;
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.pk-portNum{cursor:pointer;background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left}
.pk-portNum:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.pk-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px}
.pk-tag{display:inline-block;padding:0 5px;border-radius:var(--dsw-radius-xs,4px);font-size:11px;
  line-height:16px;white-space:nowrap}
.pk-tag--framework{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));
  background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}
.pk-tag--service{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}
.pk-tag--infra{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}
.pk-tag--local{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}
.pk-tag--limited{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}
.pk-tag--public{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}
.pk-processLine{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.pk-process{font-weight:500;overflow-wrap:anywhere}
.pk-pathLine{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pk-tag--docker{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));
  background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));cursor:help}
.pk-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.pk-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-variant-numeric:tabular-nums}
.pk-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.pk-started{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.pk-actionsTd{white-space:nowrap;text-align:right}
.pk-colPort{width:132px}
.pk-colPid{width:88px}
.pk-colStarted{width:112px}
.pk-colAction{width:96px}
.pk-detailTd{padding:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.pk-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 20px;padding:12px 16px}
.pk-detailItem{display:flex;flex-direction:column;gap:2px;min-width:0}
.pk-detailLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.pk-detailValue{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.pk-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.pk-foot{flex:none;padding:8px 2px 12px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.pk-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;display:flex;
  align-items:center;gap:10px;width:max-content;max-width:min(520px,calc(100vw - 48px));
  padding:12px 16px;border-radius:var(--dsw-radius-lg,16px);
  background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary));
  font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.24));
  transform:translate(-50%);animation:pk-toast-in .16s ease-out,pk-toast-fade 1s ease var(--dsh-toast-hold,3s) forwards}
.pk-toast--error{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.pk-toastIcon{display:grid;place-items:center;flex:none;color:var(--dsw-alias-state-success-primary)}
.pk-toast--error .pk-toastIcon{color:inherit}
@keyframes pk-toast-in{0%{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%)}}
@keyframes pk-toast-fade{to{opacity:0;visibility:hidden}}
@media(prefers-reduced-motion:reduce){.pk-toast{animation:pk-toast-fade 1s ease var(--dsh-toast-hold,3s) forwards}}
.pk-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(0,0,0,.32);pointer-events:auto}
/* The dialog is a column that fills the overlay but never scrolls itself: the
   action buttons must stay reachable while a long command line scrolls inside
   its own box. A java -cp ... classpath runs to thousands of characters, and
   scrolling the whole dialog pushed 「结束」 off screen. */
.pk-dialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(480px,100%);
  max-height:100%;overflow:hidden;
  border-radius:var(--dsw-radius-lg,16px);border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));padding:20px;
  box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.24))}
.pk-dialogTitle{margin:0 0 8px;font-size:16px;line-height:24px;font-weight:600}
.pk-dialogBody{margin:0 0 16px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.pk-dialogBody code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
/* A command line can be arbitrarily long; cap it to a few lines and let it
   scroll so the surrounding copy and the buttons keep their place. */
.pk-commandBlock{margin:0 0 16px;flex:none;max-height:96px;overflow:auto;
  padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  overflow-wrap:anywhere;white-space:pre-wrap;scrollbar-width:thin}
/* Sections that must not shrink when the column is tight. */
.pk-dialogTitle,.pk-dialogHint,.pk-multiPort,.pk-dialogActions{flex:none}
.pk-dialogHint{margin:0 0 16px;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:19px}
.pk-multiPort{margin:0 0 16px;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);
  border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}
.pk-multiPortHead{font-size:12px;line-height:19px;color:var(--dsw-alias-state-warn-primary);font-weight:500}
.pk-multiPortList{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.pk-multiPortNote{margin-top:8px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.pk-portChip{display:inline-block;padding:1px 7px;border-radius:var(--dsw-radius-xs,4px);
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;
  background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));
  color:var(--dsw-alias-label-secondary)}
.pk-portChip--target{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-foreground)}
.pk-dialogActions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.pk-blockedFacts{margin:0 0 16px;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-layer-2);
  /* Narrower than the row detail panel it borrows its classes from: inside a
     480px dialog the shared 240px minimum would stack every fact on its own
     line. Two short columns read faster here. */
  grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 16px}
.pk-icon{display:block;flex:none}
/* ---- settings form (Plugins page → this plugin) ------------------------- */
.pk-settings{display:flex;flex-direction:column;gap:14px;margin:0 0 20px;
  padding:16px 18px;border-radius:var(--dsw-radius-md,12px);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary)}
.pk-settingsHead{display:flex;flex-direction:column;gap:3px}
.pk-settingsTitle{margin:0;font-size:14px;line-height:21px;font-weight:600}
.pk-settingsHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.pk-settingRow{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;flex-wrap:wrap}
.pk-settingText{display:flex;flex-direction:column;gap:2px;min-width:200px;flex:1}
.pk-settingLabel{font-size:13px;line-height:20px;font-weight:500}
.pk-settingHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.pk-settingError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
`

    /**
     * The sidebar glyph: a port socket with a severed link.
     * @param {{ size?: number }} props - requested edge length.
     * @returns {import('react').ReactElement} the icon.
     */
    function PanelIcon({ size = 16 }) {
      return h(
        'svg',
        {
          className: 'pk-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 12, cy: 9, r: 4.2 }),
        h('circle', { cx: 12, cy: 9, r: 1.4, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M12 13.2v3.4' }),
        h('path', { d: 'M4.4 20.2h4.2' }),
        h('path', { d: 'M15.4 20.2h4.2' }),
      )
    }

    /**
     * The panel's stylesheet, mounted only while the panel is.
     * @returns {import('react').ReactElement} a style element.
     */
    function Styles() {
      return h('style', { 'data-dsh-plugin': NS }, CSS)
    }

    /**
     * The menu text for one sidebar-label mode.
     *
     * Written as explicit branches rather than a computed key: the
     * dictionary-completeness test only sees literal translate calls, and a
     * template-built key would look like an undefined string.
     * @param {string} mode - `auto`, `zh` or `en`.
     * @param {Function} t - the translator.
     * @returns {string} the option text.
     */
    function navLabelOptionText(mode, t) {
      if (mode === 'zh') return t('navLabelZh')
      if (mode === 'en') return t('navLabelEn')
      return t('navLabelAuto')
    }

    /**
     * The plugin's own configuration, shown on its page under 插件.
     *
     * Registered into `plugins.bundle.config` rather than `plugins.detail.section`:
     * the former is dispatched directly under the plugin's title and above its
     * README, while the latter sits at the very bottom after the documentation,
     * the component rows and the install source. A settings form at the bottom of
     * a long README is a form nobody scrolls to.
     *
     * The page asks for `view: 'summary'` where a one-liner is wanted; this form
     * has no one-liner, so that view renders nothing.
     * @param {{ view?: string, t?: Function }} props - the page's requested view.
     * @returns {import('react').ReactElement | null} the form, or null.
     */
    function BundleConfig({ view, t }) {
      if (view === 'summary') return null

      const [current, setCurrent] = useState(settingsStore.current)
      const [error, setError] = useState(null)

      useEffect(() => {
        let mounted = true
        // The form may be opened before the panel ever ran, so it reads the
        // settings itself rather than trusting a store nobody has filled yet.
        void loadSettings().then(() => {
          if (mounted) setCurrent(settingsStore.current)
        })
        const unsubscribe = subscribeSettings((next) => {
          if (mounted) setCurrent(next)
        })
        return () => {
          mounted = false
          unsubscribe()
        }
      }, [])

      /**
       * Write one field, showing a refusal rather than pretending it saved.
       * @param {object} patch - the field to change.
       * @returns {Promise<void>} resolution after the Host answers.
       */
      const commit = async (patch) => {
        setError(null)
        const saved = await saveSettings(patch)
        if (saved === null) setError(t('settingsSaveFailed'))
      }

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'section',
          { className: 'pk-settings', 'aria-label': t('settingsTitle') },
          h(
            'div',
            { className: 'pk-settingsHead' },
            h('h4', { className: 'pk-settingsTitle' }, t('settingsTitle')),
            h('p', { className: 'pk-settingsHint' }, t('settingsHint')),
          ),
          // The refresh cadence deliberately has no control here: the panel's
          // own toolbar already owns it, and two controls for one value make the
          // reader wonder which one is authoritative. The hint below says where
          // it lives so this page does not read as "the setting is missing".
          h(
            'div',
            { className: 'pk-settingRow' },
            h(
              'div',
              { className: 'pk-settingText' },
              h('label', { className: 'pk-settingLabel', htmlFor: 'pk-set-nav' }, t('settingsNavLabel')),
              h('p', { className: 'pk-settingHint' }, t('settingsNavLabelHint')),
            ),
            h(
              'select',
              {
                id: 'pk-set-nav',
                className: 'pk-select',
                value: current.navLabel,
                onChange: (event) => {
                  const value = event.target.value
                  setCurrent((previous) => ({ ...previous, navLabel: value }))
                  void commit({ navLabel: value })
                },
              },
              ...NAV_LABEL_CHOICES.map((mode) =>
                h('option', { key: mode, value: mode }, navLabelOptionText(mode, t)),
              ),
            ),
          ),
          error === null
            ? null
            : h('p', { className: 'pk-settingError', role: 'alert' }, error),
        ),
      )
    }

    /**
     * The confirmation dialog for ending a process.
     *
     * Ending a process is destructive and cannot be undone, so the target is
     * named in full — port, pid, name and command — rather than asking a generic
     * "are you sure". When the process holds more than one port the dialog also
     * lists them: the signal takes all of them, and a user who wanted to free
     * :8012 needs to know that ending it also closes the other seven.
     * @param {object} props - the dialog's inputs.
     * @returns {import('react').ReactElement | null} the dialog, or null when closed.
     */
    function KillDialog({ target, ports, capabilities, busy, t, onCancel, onConfirm }) {
      const confirmRef = useRef(null)

      useEffect(() => {
        if (target === null) return undefined
        confirmRef.current?.focus?.()
        const onKey = (event) => {
          if (event.key === 'Escape' && busy !== true) onCancel()
        }
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('keydown', onKey)
        }
      }, [target, busy, onCancel])

      if (target === null) return null

      return h(
        'div',
        {
          className: 'pk-overlay',
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && busy !== true) onCancel()
          },
        },
        h(
          'div',
          {
            className: 'pk-dialog',
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': 'pk-kill-title',
          },
          h('h2', { className: 'pk-dialogTitle', id: 'pk-kill-title' }, t('killTitle')),
          h(
            'p',
            { className: 'pk-dialogBody' },
            format(t('killBody'), {
              port: target.port,
              name: target.processName,
              pid: target.pid,
            }),
          ),
          h(
            'div',
            { className: 'pk-commandBlock', title: target.command || target.processName },
            target.command || target.processName,
          ),
          // Only shown when there is more than one port: a process holding a
          // single port has nothing extra to warn about, and repeating the port
          // already named above would be noise.
          ports.length > 1
            ? h(
                'div',
                { className: 'pk-multiPort' },
                h(
                  'div',
                  { className: 'pk-multiPortHead' },
                  format(t('killMultiPort'), { n: ports.length, pid: target.pid }),
                ),
                h(
                  'div',
                  { className: 'pk-multiPortList' },
                  ...ports.map((port) =>
                    h(
                      'span',
                      {
                        key: port,
                        className: port === target.port ? 'pk-portChip pk-portChip--target' : 'pk-portChip',
                      },
                      `:${String(port)}`,
                    ),
                  ),
                ),
                // Says why one click can close several ports; without it the
                // list reads as a warning without a cause.
                h('div', { className: 'pk-multiPortNote' }, t('killMultiPortNote')),
              )
            : null,
          // The two buttons send different signals, and the difference decides
          // whether the process gets to save its work. Naming the signals alone
          // ("TERM"/"KILL") describes the mechanism without stating the
          // consequence, so the consequences are spelled out here instead.
          // A platform without a catchable signal has no difference to explain,
          // and claiming one would be a promise it cannot keep.
          h(
            'p',
            { className: 'pk-dialogHint' },
            capabilities !== null && capabilities.gracefulSignal === false
              ? t('killHintNoGraceful')
              : t('killHint'),
          ),
          h(
            'div',
            { className: 'pk-dialogActions' },
            h(
              'button',
              { type: 'button', className: 'pk-btn', onClick: onCancel, disabled: busy === true },
              t('cancel'),
            ),
            // The sharper option is outlined, not filled: it should be found on
            // purpose, not be the most eye-catching thing in the dialog.
            h(
              'button',
              {
                type: 'button',
                className: 'pk-btn pk-btn--danger',
                title: t('killForceHint'),
                disabled: busy === true,
                onClick: () => onConfirm(true),
              },
              t('killForce'),
            ),
            // Rightmost and filled: the ordinary path, and the focused default.
            h(
              'button',
              {
                type: 'button',
                className: 'pk-btn pk-btn--primary',
                ref: confirmRef,
                title: t('killConfirmHint'),
                disabled: busy === true,
                onClick: () => onConfirm(false),
              },
              busy === true ? t('killing') : t('killConfirm'),
            ),
          ),
        ),
      )
    }

    /**
     * Why one row cannot be ended, shown in the same dialog shell as a kill.
     *
     * A disabled button cannot explain itself: Chromium shows no tooltip on a
     * disabled control, and not on its wrapper either while the control still
     * swallows the hover. Rather than leave a dead button, the row's 「结束」
     * opens this instead — the user asked to end something, so the answer to
     * "why can't I" belongs where they looked.
     *
     * It reuses the kill dialog's box, so it reads as the same surface rather
     * than a different kind of message.
     * @param {object} props - the row, the platform flags and the translator.
     * @returns {import('react').ReactElement | null} the dialog, or null when closed.
     */
    function BlockedDialog({ target, capabilities, t, onClose }) {
      const closeRef = useRef(null)

      useEffect(() => {
        if (target === null) return undefined
        closeRef.current?.focus?.()
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('keydown', onKey)
        }
      }, [target, onClose])

      if (target === null) return null

      const container =
        target.container === null || target.container === undefined ? null : target.container
      const reason =
        container === null
          ? dockerProxyReason(capabilities, t)
          : format(t('dockerNoKill'), { name: container.name })

      return h(
        'div',
        {
          className: 'pk-overlay',
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            className: 'pk-dialog',
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': 'pk-blocked-title',
          },
          h(
            'h2',
            { className: 'pk-dialogTitle', id: 'pk-blocked-title' },
            t('dockerBlockedTitle'),
          ),
          h(
            'p',
            { className: 'pk-dialogBody' },
            format(t('dockerBlockedBody'), {
              port: target.port,
              name: target.processName,
              pid: target.pid,
            }),
          ),
          h('p', { className: 'pk-dialogHint' }, reason),
          // The container facts are what tell the user which thing to stop, so
          // they are listed rather than folded into the sentence above.
          container === null
            ? null
            : h(
                'div',
                { className: 'pk-detail pk-blockedFacts' },
                detailItem(t('detailContainer'), container.name),
                detailItem(t('dockerImageLabel'), container.image),
                container.project === '' || container.project === undefined
                  ? null
                  : detailItem(t('dockerProjectLabel'), container.project),
              ),
          h(
            'div',
            { className: 'pk-dialogActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'pk-btn pk-btn--primary',
                ref: closeRef,
                onClick: onClose,
              },
              t('dismiss'),
            ),
          ),
        ),
      )
    }

    /**
     * A transient notice that floats over the frame.
     *
     * Success needs no acknowledgement — the row disappearing from the table is
     * the result. The notice is drawn as the shipped toast is (top-centre,
     * non-interactive, fades on its own) and it never pushes content around,
     * which a banner in the layout would.
     * @param {object} props - the notice and translator.
     * @returns {import('react').ReactElement | null} the toast, or null.
     */
    function Toast({ notice, t }) {
      // Keying on the text restarts the fade for a second kill, which a stable
      // element would swallow.
      if (notice === null) return null

      return h(
        'div',
        {
          className: notice.tone === 'error' ? 'pk-toast pk-toast--error' : 'pk-toast',
          role: notice.tone === 'error' ? 'alert' : 'status',
          key: notice.text,
        },
        h(
          'span',
          { className: 'pk-toastIcon', 'aria-hidden': true },
          notice.tone === 'error' ? '\u2715' : '\u2713',
        ),
        h('span', null, notice.text),
      )
    }

    /**
     * One row plus its expandable detail panel.
     * @param {object} props - row inputs.
     * @returns {import('react').ReactElement} the row group.
     */
    function PortRow({ item, expanded, killing, currentUser, capabilities, t, onToggle, onKill, onExplain }) {
      const exposure = exposureOf(item.hosts)
      // Only the wide case renders, so one label is enough; the other two keys
      // stay in the dictionary for the tooltip and the tests to agree on.
      const exposureLabel = t('exposureWide')

      // Docker's proxy holds every published port, so signalling it is both
      // destructive and futile: the container keeps running and the other
      // published ports stop working.
      //
      // `dockerProxy` covers the case where the process is recognisably Docker's
      // but no container claims the port — the daemon is down or the listing is
      // stale. That is still never a safe target, even when the container behind
      // it cannot be named.
      //
      // The button stays clickable and opens an explanation instead of a kill
      // dialog. A disabled button cannot explain itself — Chromium shows no
      // tooltip on one, and not even on its wrapper while the button still
      // swallows the hover — so the explanation has to be a surface the user can
      // actually reach.
      const blocked =
        (item.container !== null && item.container !== undefined) || item.dockerProxy === true

      return h(
        React.Fragment,
        null,
        h(
          'tr',
          { className: 'pk-row' },
          h(
            'td',
            { className: 'pk-td' },
            h(
              'button',
              {
                type: 'button',
                className: 'pk-portNum',
                onClick: () => onToggle(item),
                'aria-expanded': expanded,
                title: expanded ? t('collapse') : t('expand'),
              },
              `:${item.port}`,
            ),
            // Only a listener that other machines can reach is worth marking.
            // Loopback is the norm, so labelling it on every row is noise that
            // trains the eye to skip the one case that matters.
            exposure.wide
              ? h(
                  'div',
                  { className: 'pk-tags' },
                  h(
                    'span',
                    {
                      className: 'pk-tag pk-tag--public',
                      title: format(t('exposureWideHint'), { hosts: item.hosts.join(', ') }),
                    },
                    exposureLabel,
                  ),
                )
              : null,
          ),
          h(
            'td',
            { className: 'pk-td' },
            h(
              'div',
              { className: 'pk-processLine' },
              h('span', { className: 'pk-process' }, item.processName),
              // The container name sits beside the process name rather than
              // replacing it: `com.docker.backend` is what a signal would reach,
              // so hiding it would make the kill button look safer than it is.
              item.container === null || item.container === undefined
                ? null
                : h(
                    'span',
                    { className: 'pk-tag pk-tag--docker', title: dockerTitle(item.container, item.port, t) },
                    `Docker · ${item.container.name}`,
                  ),
            ),
            // The path is what tells two same-named processes apart, so it gets
            // the second line; the pid and owner move to the detail panel, which
            // already shows them.
            h(
              'div',
              { className: 'pk-muted pk-mono pk-pathLine', title: item.cwd ?? item.command ?? '' },
              processMeta(item, currentUser),
            ),
          ),
          h('td', { className: 'pk-td pk-num pk-mono' }, String(item.pid)),
          h(
            'td',
            { className: 'pk-td' },
            h('div', { className: 'pk-muted' }, item.hostSummary),
          ),
          h(
            'td',
            { className: 'pk-td pk-started' },
            shortStartedAt(item.startedAt, t),
          ),
          h(
            'td',
            { className: 'pk-td pk-actionsTd' },
            h(
              'button',
              {
                type: 'button',
                className: 'pk-btn pk-btn--danger',
                disabled: killing,
                onClick: () => (blocked ? onExplain(item) : onKill(item)),
              },
              killing ? t('killing') : t('kill'),
            ),
          ),
        ),
        expanded
          ? h(
              'tr',
              null,
              h(
                'td',
                { className: 'pk-detailTd', colSpan: 6 },
                h(
                  'div',
                  { className: 'pk-detail' },
                  detailItem(t('detailCommand'), h('code', null, item.command || t('unknown'))),
                  detailItem(t('detailCwd'), item.cwd ?? t('unavailable')),
                  detailItem(t('detailHosts'), item.hosts.join('  |  ') || '-'),
                  // Omitted rather than shown as "unavailable": a platform that
                  // cannot attribute socket owners (Windows) would otherwise put
                  // the same dead field on every row.
                  typeof item.user === 'string' && item.user !== ''
                    ? detailItem(t('detailUser'), item.user)
                    : null,
                  detailItem(t('detailProto'), `${item.protocol} · ${item.state}`),
                  detailItem(t('detailStarted'), item.startedAt ?? t('unknown')),
                  // The container belongs in the detail panel too: the row badge
                  // is a summary, this is the place with room for image and
                  // compose project.
                  item.container === null || item.container === undefined
                    ? null
                    : detailItem(
                        t('detailContainer'),
                        [
                          item.container.name,
                          item.container.image,
                          item.container.project === '' ? null : item.container.project,
                        ]
                          .filter((part) => part !== null && part !== '')
                          .join(' · '),
                      ),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * One labelled field inside an expanded row.
     * @param {string} label - field name.
     * @param {import('react').ReactNode} value - field content.
     * @returns {import('react').ReactElement} the field.
     */
    function detailItem(label, value) {
      return h(
        'div',
        { className: 'pk-detailItem' },
        h('span', { className: 'pk-detailLabel' }, label),
        h('span', { className: 'pk-detailValue pk-mono' }, value),
      )
    }

    /**
     * The whole page: toolbar, table, dialog and refresh loop.
     * @param {object} props - slot props; `t` comes from the registration's locale face.
     * @returns {import('react').ReactElement} the panel.
     */
    function PortKillPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      // The heading follows the same `navLabel` setting as the sidebar, so the
      // two never disagree about what this page is called.
      const navTitle =
        typeof props.navTitle === 'function' ? props.navTitle : () => t('title')

      const [items, setItems] = useState([])
      // Every port each pid holds, published with the list. A signal ends the
      // process, not the socket, so a row's kill button can take several ports
      // down with it — the dialog has to say which before the user commits.
      const [portsByPid, setPortsByPid] = useState({})
      // What this platform can actually do. A platform without a catchable
      // signal must not be told its work will be saved.
      const [capabilities, setCapabilities] = useState(null)
      const [currentUser, setCurrentUser] = useState('')
      const [query, setQuery] = useState('')
      const [sortKey, setSortKey] = useState('recent')
      const [sortOrder, setSortOrder] = useState('descend')
      const [expandedKey, setExpandedKey] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [error, setError] = useState(null)
      const [lastUpdated, setLastUpdated] = useState(null)
      const [killTarget, setKillTarget] = useState(null)
      // A row whose port belongs to Docker: clicking 结束 explains why instead
      // of offering to signal the forwarding proxy.
      const [blockedTarget, setBlockedTarget] = useState(null)
      const [killingPid, setKillingPid] = useState(null)
      const [notice, setNotice] = useState(null)
      // Seeded from the settings store, then kept in sync with it: the Host is
      // the source of truth, so a value confirmed there wins over this default.
      const [refreshMs, setRefreshMs] = useState(settingsStore.current.refreshMs)
      const [scanMs, setScanMs] = useState(null)

      // The toast's CSS fades it out after the hold time; this clears the state
      // at the same moment so the element really leaves the DOM and a repeated
      // message can animate again. An error is held longer: it reports a refusal
      // the user has to read.
      const noticeTimer = useRef(null)
      const showNotice = useCallback((next) => {
        if (noticeTimer.current !== null) {
          window.clearTimeout(noticeTimer.current)
          noticeTimer.current = null
        }
        setNotice(next)
        const holdMs = next.tone === 'error' ? 8_000 : 4_000
        noticeTimer.current = window.setTimeout(() => {
          noticeTimer.current = null
          setNotice(null)
        }, holdMs)
      }, [])

      useEffect(
        () => () => {
          if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
        },
        [],
      )

      // A scan in flight must not be duplicated by the timer, and a result that
      // arrives after unmount must not set state.
      const inFlight = useRef(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      // Read the Host settings once, and follow later changes. Both the refresh
      // cadence and the sidebar label read the same store, so a change made in
      // the plugin page reaches this panel without a reload.
      useEffect(() => {
        void loadSettings()
        return subscribeSettings((next) => {
          if (alive.current) setRefreshMs(next.refreshMs)
        })
      }, [])

      /**
       * Fetch the port list. `silent` keeps the previous rows on screen while a
       * background refresh runs, which is what makes auto-refresh tolerable.
       * @param {{ silent?: boolean }} [options] - behaviour flags.
       * @returns {Promise<void>} resolution after the state is applied.
       */
      const load = useCallback(async (options = {}) => {
        if (inFlight.current) return
        inFlight.current = true

        const silent = options.silent === true
        if (silent) setRefreshing(true)
        else setLoading(true)

        try {
          const startedAt = Date.now()
          const response = await fetch(PORTS_PATH, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          })
          if (!response.ok) {
            const detail = await response.json().catch(() => null)
            throw new Error(detail?.message ?? `HTTP ${String(response.status)}`)
          }
          const body = await response.json()
          if (!alive.current) return
          setItems(Array.isArray(body.items) ? body.items : [])
          setCapabilities(
            body.capabilities !== null && typeof body.capabilities === 'object'
              ? body.capabilities
              : null,
          )
          setPortsByPid(
            body.portsByPid !== null && typeof body.portsByPid === 'object'
              ? body.portsByPid
              : {},
          )
          setCurrentUser(typeof body.currentUser === 'string' ? body.currentUser : '')
          setLastUpdated(new Date())
          setScanMs(Date.now() - startedAt)
          setError(null)
        } catch (cause) {
          if (!alive.current) return
          // A failed refresh keeps the last good rows: a transient lsof failure
          // must not blank a list the user is reading.
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          inFlight.current = false
          if (alive.current) {
            setLoading(false)
            setRefreshing(false)
          }
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      // Auto-refresh: cleared on unmount and restarted whenever the cadence
      // changes. `refreshMs === 0` means off.
      useEffect(() => {
        if (refreshMs <= 0) return undefined
        const timer = window.setInterval(() => {
          void load({ silent: true })
        }, refreshMs)
        return () => {
          window.clearInterval(timer)
        }
      }, [refreshMs, load])

      const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        if (keyword === '') return items
        return items.filter((item) => {
          const haystack = [
            String(item.port),
            String(item.pid),
            item.processName,
            item.command,
            item.cwd ?? '',
            item.hosts.join(' '),
          ]
            .join(' ')
            .toLowerCase()
          return haystack.includes(keyword)
        })
      }, [items, query])

      const sorted = useMemo(() => {
        const rows = [...filtered]

        // Three keys deep, like the original. The important part is *where* the
        // sort direction is applied: the original negates the whole comparison,
        // tie-breakers included, rather than multiplying only the primary key.
        //
        // That distinction is visible. One process holding several ports has one
        // identical start time for every row, so those rows are ordered purely by
        // the port tie-breaker — and negating the whole comparison makes that
        // tie-breaker descend too, which is what the original shows.
        const compare = (left, right) => {
          if (sortKey === 'port') return left.port - right.port || left.pid - right.pid
          if (sortKey === 'process') {
            return (
              left.processName.localeCompare(right.processName) ||
              left.port - right.port ||
              left.pid - right.pid
            )
          }
          return (
            (left.startedAtTs ?? 0) - (right.startedAtTs ?? 0) ||
            left.port - right.port ||
            left.pid - right.pid
          )
        }

        rows.sort((left, right) => {
          const baseResult = compare(left, right)
          return sortOrder === 'ascend' ? baseResult : -baseResult
        })
        return rows
      }, [filtered, sortKey, sortOrder])

      /**
       * Toggle a column's sort, defaulting to the order that column reads best in.
       * @param {'recent' | 'port' | 'process'} key - the column.
       */
      const toggleSort = useCallback(
        (key) => {
          if (sortKey === key) {
            setSortOrder((previous) => (previous === 'ascend' ? 'descend' : 'ascend'))
            return
          }
          setSortKey(key)
          setSortOrder(key === 'recent' ? 'descend' : 'ascend')
        },
        [sortKey],
      )

      /**
       * End the confirmed target and, if it worked, ask whether the port came back.
       * @param {boolean} force - true sends KILL instead of TERM.
       * @returns {Promise<void>} resolution after the outcome is shown.
       */
      const confirmKill = useCallback(
        async (force) => {
          const target = killTarget
          if (target === null) return

          setKillingPid(target.pid)
          try {
            const response = await fetch(KILL_PATH, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                pid: target.pid,
                force,
                expectedPort: target.port,
                expectedStartedAtTs: target.startedAtTs,
                expectedProcessName: target.processName,
                expectedUser: target.user,
              }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
              // Carry the host's stable code through: "HTTP 401" alone does not
              // tell the user whether the fence refused the request or the
              // process check did.
              const detail = body?.message ?? '未知错误'
              const code = typeof body?.code === 'string' ? ` (${body.code})` : ''
              throw new Error(`${detail}${code} [HTTP ${String(response.status)}]`)
            }

            setKillTarget(null)
            // The host scans and reports the ports actually released. Falling
            // back to the message alone keeps a stale grouping from producing a
            // toast that contradicts what the user just saw.
            const released = Array.isArray(body?.affectedPorts) ? body.affectedPorts : null
            showNotice({
              tone: 'ok',
              text:
                released !== null && released.length > 1
                  ? format(t('killedMultiPort'), { n: released.length })
                  : (body?.message ?? t('killed')),
            })
            await load({ silent: true })

            // A watcher restarts what it supervises, so the port may be back
            // under a new pid within a second. Say so instead of leaving the
            // user to wonder why the row reappeared.
            window.setTimeout(() => {
              void (async () => {
                try {
                  const reboundResponse = await fetch(REBOUND_PATH, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      port: target.port,
                      previousPid: target.pid,
                      previousProcessName: target.processName,
                    }),
                  })
                  if (!reboundResponse.ok) return
                  const rebound = await reboundResponse.json()
                  if (rebound.occupied === true && rebound.message !== null && alive.current) {
                    showNotice({ tone: 'warn', text: rebound.message })
                    await load({ silent: true })
                  }
                } catch {
                  // A rebound probe is advisory; losing it must not alarm anyone.
                }
              })()
            }, REBOUND_DELAY_MS)
          } catch (cause) {
            setKillTarget(null)
            showNotice({
              tone: 'error',
              text: cause instanceof Error ? cause.message : String(cause),
            })
            await load({ silent: true })
          } finally {
            if (alive.current) setKillingPid(null)
          }
        },
        [killTarget, load, t],
      )

      const statusText = loading
        ? t('loading')
        : refreshing
          ? t('refreshing')
          : error !== null
            ? t('failed')
            : lastUpdated === null
              ? t('never')
              : t('updated')

      const sortMark = (key) =>
        sortKey === key ? h('span', { className: 'pk-sortMark' }, sortOrder === 'ascend' ? '▲' : '▼') : null

      return h(
        'div',
        { className: 'pk-root' },
        h(Styles),
        h(
          'div',
          { className: 'pk-inner' },
          h(
            'div',
            { className: 'pk-head' },
            h(
              'div',
              { className: 'pk-headText' },
              h('h1', { className: 'pk-title' }, navTitle()),
              h('div', { className: 'pk-subtitle' }, t('subtitle')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pk-btn',
                onClick: () => {
                  void load({ silent: true })
                },
                disabled: loading || refreshing,
              },
              refreshing ? t('refreshing') : t('refresh'),
            ),
          ),
          h(
            'div',
            { className: 'pk-toolbar' },
            h(
              'div',
              { className: 'pk-search' },
              h('input', {
                type: 'search',
                className: 'pk-searchInput',
                value: query,
                placeholder: t('search'),
                'aria-label': t('search'),
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h(
              'select',
              {
                className: 'pk-select',
                value: String(refreshMs),
                'aria-label': t('autoRefresh'),
                title: t('autoRefresh'),
                onChange: (event) => {
                  const value = Number(event.target.value)
                  // Optimistic: the control answers immediately, then the Host
                  // confirms. A refusal leaves the previous value in the store.
                  setRefreshMs(value)
                  void saveSettings({ refreshMs: value })
                },
              },
              REFRESH_CHOICES.map((choice) =>
                h(
                  'option',
                  { key: choice.value, value: String(choice.value) },
                  `${t('autoRefresh')}: ${t(choice.key)}`,
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'pk-meta' },
            h(
              'span',
              null,
              h('strong', null, statusText),
              lastUpdated === null
                ? null
                : ` · ${lastUpdated.toLocaleTimeString()}`,
              scanMs === null ? null : ` · ${String(scanMs)}ms`,
            ),
            h(
              'span',
              null,
              query.trim() === ''
                ? format(t('total'), { n: items.length })
                : format(t('filtered'), { shown: filtered.length, total: items.length }),
            ),
            currentUser === '' ? null : h('span', null, `${t('detailUser')}: ${currentUser}`),
          ),
          error === null
            ? null
            : h(
                'div',
                { className: 'pk-error', role: 'alert' },
                h('span', null, error),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pk-btn',
                    onClick: () => {
                      void load({ silent: true })
                    },
                  },
                  t('retry'),
                ),
              ),
          h(
            'div',
            { className: 'pk-tableWrap' },
            h(
              'table',
              { className: 'pk-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  sortableHeader(t('colPort'), 'port', sortKey, toggleSort, sortMark, 'pk-colPort'),
                  sortableHeader(t('colProcess'), 'process', sortKey, toggleSort, sortMark),
                  h('th', { className: 'pk-th pk-colPid' }, h('span', { className: 'pk-thStatic' }, t('colPid'))),
                  h('th', { className: 'pk-th' }, h('span', { className: 'pk-thStatic' }, t('colAddress'))),
                  sortableHeader(t('colStarted'), 'recent', sortKey, toggleSort, sortMark, 'pk-colStarted'),
                  h('th', { className: 'pk-th pk-colAction' }, h('span', { className: 'pk-thStatic' }, t('colActions'))),
                ),
              ),
              h(
                'tbody',
                null,
                sorted.length === 0
                  ? h(
                      'tr',
                      null,
                      h(
                        'td',
                        { className: 'pk-empty', colSpan: 6 },
                        loading
                          ? t('loading')
                          : error !== null
                            ? // The scan never ran, so "nothing is listening" would
                              // be a claim about a machine that was never read.
                              t('scanFailed')
                            : items.length === 0
                              ? t('empty')
                              : t('emptyFiltered'),
                      ),
                    )
                  : sorted.map((item) => {
                      const rowKey = `${String(item.pid)}:${String(item.port)}`
                      return h(PortRow, {
                        key: rowKey,
                        item,
                        expanded: expandedKey === rowKey,
                        killing: killingPid === item.pid,
                        currentUser,
                        capabilities,
                        t,
                        onToggle: (target) =>
                          setExpandedKey((previous) =>
                            previous === rowKey ? null : rowKey,
                          ),
                        onKill: (target) => {
                          setKillTarget(target)
                          setNotice(null)
                        },
                        onExplain: (target) => {
                          setBlockedTarget(target)
                          setNotice(null)
                        },
                      })
                    }),
              ),
            ),
          ),
          h('div', { className: 'pk-foot' }, t('limitNote')),
        ),
        h(KillDialog, {
          target: killTarget,
          ports: killTarget === null ? [] : affectedPortsOf(portsByPid, killTarget),
          capabilities,
          busy: killingPid !== null,
          t,
          onCancel: () => setKillTarget(null),
          onConfirm: confirmKill,
        }),
        h(BlockedDialog, {
          target: blockedTarget,
          capabilities,
          t,
          onClose: () => setBlockedTarget(null),
        }),
        h(Toast, { notice, t }),
      )
    }

    /**
     * One sortable column header.
     * @param {string} label - visible text.
     * @param {'recent' | 'port' | 'process'} key - sort key.
     * @param {string} activeKey - the current sort key.
     * @param {(key: string) => void} onToggle - sort handler.
     * @param {(key: string) => import('react').ReactNode} mark - direction marker renderer.
     * @returns {import('react').ReactElement} the header cell.
     */
    function sortableHeader(label, key, activeKey, onToggle, mark, widthClass) {
      return h(
        'th',
        {
          className: widthClass === undefined ? 'pk-th' : `pk-th ${widthClass}`,
          'aria-sort':
            activeKey === key
              ? undefined
              : 'none',
        },
        h(
          'button',
          {
            type: 'button',
            className: 'pk-thButton',
            onClick: () => onToggle(key),
          },
          label,
          mark(key),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        let t = (key) => key

        if (
          locale !== undefined &&
          typeof locale.register === 'function' &&
          typeof locale.bind === 'function'
        ) {
          ctx.effect(() => locale.register(NS, DICT), 'port-kill: dictionaries')
          const bound = locale.bind(NS)
          if (typeof bound === 'function') t = bound
        }

        // Read the stored settings immediately. The sidebar label is resolved
        // during startup, long before any of our components mount, so waiting
        // for the panel to load them would leave the label on its default.
        void loadSettings()

        // The label both the sidebar and the page heading read. Declared before
        // either registration so neither can capture it in its temporal dead
        // zone, and resolved per call so it always reflects current state.
        const navLabel = () => {
          const active =
            locale !== undefined && typeof locale.getLocale === 'function'
              ? locale.getLocale()
              : undefined
          // `LocaleSnapshot.active` is the language id, e.g. `zh`.
          const language = navLabelLanguage(settingsStore.current, active?.active)
          return DICT[language]['nav']
        }

        // The page. `inject` gives the component its `t` without a prop drill.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              // `navTitle` is the live label resolver, not a snapshot: the page
              // reads it on every render.
              inject: () => ({ t, navTitle: navLabel }),
            },
            PortKillPanel,
          ),
        )

        // The way in: one rail icon whose id addresses the `main` key above.
        //
        // The label honours the `navLabel` setting, so a user may keep the
        // English name inside a Chinese interface (or the reverse). Reading the
        // setting here — rather than inside a component — is what lets the
        // sidebar and the page title agree.
        // The sidebar keeps the label it was registered with, and nothing
        // re-renders it on our behalf — so a changed label means a rebuilt
        // entry. Re-registering is guarded by the resolved text, so a settings
        // write that does not affect the label costs nothing.
        let disposeEntry = null
        let mountedLabel = null
        const mountEntry = () => {
          const next = navLabel()
          if (disposeEntry !== null && next === mountedLabel) return
          if (disposeEntry !== null) disposeEntry()
          mountedLabel = next
          disposeEntry = ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              // Captured, not re-read: this registration IS the resolved label.
              label: () => next,
              locale: NS,
            },
            (owner = {}) => h(PanelIcon, { size: owner.size ?? 16 }),
          )
        }

        ctx.slots.inject('sidebar.panellist', () => {
          mountEntry()
          // Two things can change the text after mount: the settings arriving
          // (at startup and from the plugin page) and the interface language.
          const unsubscribeSettings = subscribeSettings(() => {
            mountEntry()
          })
          const unsubscribeLocale =
            locale !== undefined && typeof locale.subscribe === 'function'
              ? locale.subscribe(() => {
                  mountEntry()
                })
              : () => {}
          return () => {
            unsubscribeSettings()
            unsubscribeLocale()
            if (disposeEntry !== null) disposeEntry()
            disposeEntry = null
            mountedLabel = null
          }
        })

        // The plugin's own settings, on its page under 插件.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS },
            BundleConfig,
          ),
        )
      },
    }
  },
})
