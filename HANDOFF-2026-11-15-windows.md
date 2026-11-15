# 交接：dsh-port-kill 的 Windows 实测与修复（2026-11-15）

这份文档是给下一个接手的人／AI 的。它记录**今天改了什么、为什么改、怎么验证的**，以及**发布前必须补齐的东西**。第 6 节是待办清单，第 7 节是仍未验证的部分。

---

## 1. 当前状态

| 项目 | 状态 |
| --- | --- |
| 工作区 | `D:\code\dsh-port-kill`，**全部未提交**（`git status` 见第 9 节） |
| 测试（Windows 11 真机） | `210 项 / 208 过 / 0 失败 / 2 跳过` |
| 插件安装 | 已装进本机 DSH，profile `desktop`，`link:D:/code/dsh-port-kill`；重启后新代码已生效并实测 |
| 版本号 | 未改，仍是 `0.1.0` |
| `CHANGELOG.md` | **仍不存在**（发布流程依赖它，见第 6 节） |
| 平台支持 | Windows 从「代码已写、未验证」变成「实测」 |

被跳过的 2 条测试是**按平台能力主动跳过**的，不是遗漏：Windows 上 `nameAttribution` / `userAttribution` 为 `false`，因此「进程名不符要拒绝」「他人进程要拒绝」这两条没有意义（见 3.6）。

---

## 2. 环境事实（复现用）

- **系统**：Windows 11 专业版，build 26300。
- **DSH**：0.2.2-rc.3，desktop profile，Web GUI 走 127.0.0.1 随机端口。
- **PATH 里没有 `node` / `npm` / `pnpm`**。本轮全部使用 DSH 自带运行时：
  - node：`C:\Users\wungj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）
  - pnpm：`C:\Users\wungj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
- **工作树是 CRLF**（`core.autocrlf`），仓库没有 `.gitattributes`。改动必须保持 CRLF，否则 `git diff` 会整文件重写。
- `package.json` 的 `files` 里列了 `docs/*.md`、`docs/images/*.png`，**这两个路径目前不存在**。本地目录安装不受影响（链接安装不读 `files`），但 `npm publish` 时它们会落空（不报错，只是没有内容）。`CHANGELOG.md` 也在 `files` 里，同样不存在。

### ⚠️ 两个环境陷阱（今天都踩到了）

1. **不要用 PowerShell 内联 here-string 写这些文件。** 本机 `[System.Text.Encoding]::Default` 是 **GB2312**，PowerShell 读取 UTF-8 脚本时会按 GBK 解释，中文会变成 `鈥?`、`鏃犳硶` 之类，然后以 UTF-8 写回，文件就永久损坏了。今天的 `platforms/parse.js` 和 `platforms/win32.js` 被这样污染过一次，已修复。**改文件请用 Node（`readFileSync`/`writeFileSync` 显式 `utf8`）或编辑器**。
2. **本机 DSH 会话里的 shell 有 Windows ACL 沙箱问题**：`windows-acl workspace grant failed: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\code\dsh-port-kill)`。本轮靠切到「完全权限」绕过。重跑测试需要同样的权限。

---

## 3. 变更清单

### 3.1 `platforms/parse.js`（产品代码，跨平台纯函数）

`deriveProcessName()` 增加一条守卫：**第一个 token 以 `-` 开头时返回空串**。

- **原因**：WSL 用**空 argv[0]** 启动 `wslrelay.exe`，命令行原文是
  ` --mode 1 --vm-id {3c9fb2b6-…} --handle 2484`（前面有个空格）。
  旧代码把 `--mode` 当成了程序名，于是 Docker 行显示成 `--mode`。
- **影响面**：macOS / Linux **不受影响**。`ps` 永远先打印映像路径，只有「命令行里根本没有程序名」时这条才会触发；此时返回空串让调用方回退到进程表里的 `Name`（`wslrelay.exe`）。
- **验证**：新增单测「returns nothing when the command line starts with a switch」；真机 `:3306` 行由 `--mode` 变为 `wslrelay.exe`。

### 3.2 `platforms/win32.js`（Windows 后端）

1. 新增导出 `forwardingProxyKind(processName)` → `'wsl' | null`，识别 `wslrelay`、`wslhost`。
   - **原因**：Docker Desktop 的发布端口在 Windows 上有两行——`com.docker.backend.exe`（`0.0.0.0`）和 `wslrelay.exe`（`[::1]`）。后者不在 `PROXY_NAMES` 里，**Docker 查不到容器时（daemon 停、超时）它会被当成普通进程给出「结束」按钮**，点下去只中断 WSL 端口转发、容器照跑。
2. `capabilities` 增加 `ancestorChainRequired: true`。
3. `ancestorChain()`：失败**重试 1 次**；仍失败则 **抛错**（旧实现返回 `[pid]`，等于"这进程没有祖先"）。

- **影响面**：仅 Windows。POSIX 没有这两个导出/标志，行为逐字不变。
- **验证**：单测「recognises the WSL loopback relay」「leaves Docker names to the Docker proxy check」「only Windows requires a provable ancestor chain」；真机 Docker 两态见 4.3。

### 3.3 `host.js`（共享层，新增逻辑只在 Windows 激活）

1. `listPorts()`：每行新增 `proxyKind: 'docker' | 'wsl' | null`。
   - 优先级：**容器归因 > WSL 中继 > Docker 转发**；`dockerProxy` 语义扩展为"任一转发中继且无容器"。
2. `selfChain()`：返回值改为 `Set | null`。`null` = 平台声明必须可证明但这次读不到，**不缓存**（下次点击会重读）。
3. `verifyIdentity()`：
   - `pid === process.pid` → 仍是 `403 refused-self`（文案不变）。
   - 链为 `null` → 新的 `503 self-check-unavailable`，拒绝而不是放行。
   - 其余比较顺序不变。
- **POSIX 行为不变**：`ancestorChainRequired` 缺省 → 走原来的 `walked = []`（保留旧的宽松行为）。
- **验证**：真机 kill harness 19/19；suite 全绿。

### 3.4 `client.js`（Web 半区）

1. `dockerProxyReason(capabilities, t, proxyKind)`：`proxyKind === 'wsl'` 时用新的 WSL 文案。
2. `BlockedDialog`：无容器且 `proxyKind === 'wsl'` 时正文用 `wslBlockedBody`。
3. 字典 zh / en 各新增 2 条：`wslBlockedBody`、`wslRelayNoKill`（`client.test.js` 的字典完整性测试通过）。
- **兼容性**：旧 host 不发 `proxyKind` 时此逻辑不触发，行为与旧版一致，没有中间态。

### 3.5 `README.md`（文档）

- Windows 一行：「**代码已写，尚未在真机验证**」→「实测（Windows 11，见下）」。
- 「读不到端口属于哪个账号」补一句：**能看到**其它账号与系统服务的监听，只是读不到归属。
- Docker 段补 Windows 实情：`com.docker.backend.exe` + WSL 的 `wslrelay.exe`，以及「一个已发布端口出现两行」。
- 「已知限制」第一条限定为 **macOS / Linux**（`lsof` 的结论不能套在 `netstat` 上）。

### 3.6 测试跨平台化（这是本轮最大的一块改动）

| 文件 | 改动 |
| --- | --- |
| `test/client-render.test.js` | 读入 `client.js` 后 `replace(/\r\n/g,'\n')` 再"抠函数"（CRLF 工作树下 `'\n    }\n'` 永不匹配） |
| `test/settings.test.js` | 路径断言改用 `path.join('port-kill','settings.json')`；新增 `import { join }` |
| `test/host-kill.test.js` | 见下 |
| `test/host-parse.test.js` | 新增 1 条：flag 开头的命令行返回空名 |
| `test/platforms.test.js` | 新增 3 条：WSL 中继识别、Docker 名字不越权、只有 Windows 要求可证明的祖先链 |

`test/host-kill.test.js` 的具体改动：

- **监听进程夹具**：`/usr/bin/python3` → `node`（`process.execPath` + `-e`）。Windows 没有 `/usr/bin/python3`。
- **watcher 夹具**：`/bin/sh` 的 `while true` 循环 → node 监督进程；子进程 pid 打到 stdout，**因为 Windows 没有进程组**，只能逐个 pid 清理。
- **能力门控**（不是削弱断言）：
  - 「进程名不符要拒绝」→ `skip: capabilities.nameAttribution === true ? false : '…'`
  - 「他人进程要拒绝」→ 同上，`userAttribution`
  - 「结束成功」→ `assert.equal(result.signal, capabilities.gracefulSignal ? 'TERM' : 'KILL')`
- `waitForPort` 超时 `5s → 20s`：Windows 单次扫描约 1.1 秒（netstat + 一次 PowerShell）。
- `after()` 额外清理被监督进程拉起的 orphan pid。
- 新增 `listenerSource()` / `spawnWatcher()` / `killWatcher()` / `orphanPids`。

> **生成代码的 ASI 陷阱**：`const sleep = (ms) => new Promise(…)` 后面紧跟 `(async () => {` 会被解析成**函数调用**（`Promise 对象 is not a function`）。今天的 watcher 就是这么挂的。现在生成的每条语句都以分号结尾，且改用 `function start(){}` + `setTimeout` 递归，不再用 async IIFE。

### 3.7 新增 `.github/workflows/test.yml`（CI）

- 触发：`push` + `pull_request`。
- 矩阵：`ubuntu-latest` / `macos-latest` / `windows-latest`，`fail-fast: false`。
- 步骤：checkout → setup-node 24 → `npm run check` → `npm test`。
- 保留了仓库原有的 CRLF 结尾、`CI: true`、并发取消策略。
- **注意**：`release.yml` 目前**不跑测试**（只做 `node --check` 和打包清单校验）。是否在发布前加 `npm test` gate，由你决定，本轮没改。

### 3.8 新增本文件

`HANDOFF-2026-11-15-windows.md`（未加入 `package.json` 的 `files`，不会被发布到 npm）。

---

## 4. 验证记录

### 4.1 测试套件（Windows 11 真机）

```
node --test "test/**/*.test.js"
→ tests 210 / pass 208 / fail 0 / skipped 2 / duration ≈ 39s
```

改动前的基线是 `181 / 169 / 12`——那 12 条全部是**夹具的 POSIX 假设**，不是产品缺陷（详见本轮对话记录）。现在 12 条全部转绿或按能力跳过。

### 4.2 真机 kill 链路（19 项，真实进程 + 真实信号）

用插件自己的 `host.js` 对着临时 node 监听进程跑，等同于点「结束」时的代码路径：

```
扫描带启动时间 / stale-list 拒绝 / identity-changed 拒绝 / start-time-missing 拒绝
Windows 跳过名字与用户比对（文档行为）/ signal=KILL / affectedPorts 正确
端口消失 / 进程真的退出 / 一个进程两个端口 / 一次 kill 释放两个端口
rebound 检测 / rebound 文案不是 "undefined" / 同进程名识别 / 无占用时不报 rebound
```

全部通过。其中「文案不是 undefined」是今天修的一个真 bug：`checkPortRebound` 用 `successor.processName !== ''` 判断，而 Windows 上该字段是 `undefined`（不是空串），于是直接打印了 `undefined`。

### 4.3 Docker（用户实际起了 MySQL + Redis 容器）

| 场景 | 结果 |
| --- | --- |
| Docker 可达 | `:3306`/`:6379` 各两行；容器归因 `mysql-local` / `redis-local`；四行全部 `killBlocked=true` |
| Docker 从 PATH 移除（模拟不可用） | `wslrelay.exe` 行 → `dockerProxy=true`、`proxyKind=wsl`、仍 blocked；`com.docker.backend.exe` 行 → `proxyKind=docker`、仍 blocked |

第二种场景就是修复前会漏掉的那条危险路径。

### 4.4 其他检查

- 7 个被改文件全部保持 CRLF、无 BOM（`LF-only = 0`）。
- 测试产生的临时监听端口（45831–45837）结束后无残留进程。
- 用户数据未被触碰：`~/.dsh/port-kill/settings.json` 保持 15:36:15 那次写入（那是用户在面板里改「自动刷新」写下的，属用户数据）。
- 重启 DSH 后实测：`:3306` 行的进程名显示为 `wslrelay.exe`（改前是 `--mode`）。

---

## 5. 行为变化摘要（给前端 / 使用者）

| 变化 | 说明 |
| --- | --- |
| 新增字段 `items[].proxyKind` | `'docker' \| 'wsl' \| null`，供 UI 选择说明文案；旧字段 `dockerProxy` 保留 |
| 新增错误码 `503 self-check-unavailable` | Windows 上读不到父子关系时拒绝结束（此前会当作"没有祖先"放行） |
| Windows 行名更准 | ` --mode 1 …` 这类没有 argv[0] 的命令行，名字回退到进程表（`wslrelay.exe`） |
| 一个 Docker 端口两行 | Windows + WSL2 的固有现象（`0.0.0.0` 与 `[::1]`），已写进 README |

---

## 6. 发布前必须做的事（给接手的人）

1. **创建 `CHANGELOG.md`**（仓库现在没有它，`scripts/release.mjs` 和 `.github/workflows/release.yml` 都会因此失败）。建议起步内容：

   ```markdown
   # Changelog

   ## Unreleased

   ### Fixed
   - Windows: a Docker-published port held by WSL's `wslrelay.exe` was labelled
     `--mode` and could be ended like an ordinary process. It is now named and
     treated as a forwarding relay, so the row cannot be killed.
   - Windows: when the parent-process query fails, the self-protection check
     refuses the kill instead of assuming the target has no ancestors.
   - The rebound report no longer prints `undefined` where the platform does not
     report a socket process name (Windows).

   ### Changed
   - Windows is verified on a real machine; the README states what it can and
     cannot do instead of "not verified yet".
   - The test suite runs on Windows: node replaces the Python/shell fixtures,
     POSIX-only comparisons are skipped by capability, and the client tests
     accept a CRLF checkout.

   ### Added
   - CI: the suite runs on Ubuntu, macOS and Windows for every push and pull
     request.
   ```

2. **决定版本号**并跑一遍 dry-run（不需要 pnpm，`scripts/release.mjs` 只用 node 内置模块）：

   ```
   node scripts/release.mjs 0.1.1 --dry-run
   ```

   它会检查：工作树是否干净、`## Unreleased` 是否存在且有正文、版本是否已发布过。
   **注意**：它要求工作树干净，所以第 4 步的提交必须先完成。

3. **`package.json` 的 `files`** 里 `docs/*.md`、`docs/images/*.png` 目前指向不存在的路径。发布前要么补文件，要么删掉这两条；`CHANGELOG.md` 必须留在 `files` 里（`release.yml` 的打包清单校验会检查它）。

4. **提交建议**（工作树里现在有 10 个改动文件 + 1 个新增文件）。可以拆成两条：

   ```
   fix(windows): name the WSL relay, refuse unprovable self-checks

   - parse: a command line starting with a switch has no image name
   - win32: recognise wslrelay/wslhost; retry the parent map and require it
   - host: publish proxyKind; refuse the kill when the chain cannot be read
   - client: WSL-specific "cannot be ended here" dialog
   - README: Windows is verified; correct the account-attribution note
   ```
   ```
   test: run the suite on Windows; ci: test the three platforms

   - node replaces the /usr/bin/python3 and /bin/sh fixtures
   - POSIX-only comparisons are skipped by capability, signal follows the platform
   - client render tests accept a CRLF checkout
   - add .github/workflows/test.yml (ubuntu, macos, windows)
   ```

5. **CI 首跑注意**：`ubuntu-latest` 需要镜像里有 `lsof`（插件在 POSIX 上全靠它）；固定端口 `45331/45332` 在 CI 上基本不会撞。若 ubuntu 腿红了，先看 `lsof` 是否存在，而不是先怀疑代码。

6. **`engines` 与实际**：`package.json` 写 `node >= 20`，而 `test` 脚本用的是 `node --test "test/**/*.test.js"`；把 glob 直接交给 `--test` 需要较新的 Node（本轮只在 v24.21.0 上验证过，**Node 20 上是否支持未验证**）。CI 用的是 24，暂时无碍；要长期兼容 20，可把脚本改成 `node --test test/`。

7. **发布后**：README 的安装段仍写「当前未发布到 npm，用本地目录安装」。如果这次要发 npm，记得同步改这一段（以及插件市场里的安装说明）。

---

## 7. 仍未验证 / 已知缺口

| 项 | 说明 |
| --- | --- |
| 提权 / 其它用户进程的「结束」 | 代码路径是 `EPERM → 403 refused-permission`，但**没有真机点过**（不愿对系统服务发信号）。Windows 上大多数行都属于这类，值得人工点一次确认文案 |
| `wslrelay.exe` 行的「命令」列 | 仍显示原始 ` --mode 1 --vm-id …`（argv[0] 为空是 WSL 的真实情况，没有伪造 `wslrelay.exe` 前缀） |
| 新 WSL 文案的页面效果 | 只做了 slot 注册与字典一致性测试，**没有在浏览器里看过** |
| Windows 恒 skip 的 2 条测试 | 能力门控所致，属预期；macOS/Linux 上仍会真实执行 |
| 冷启动首扫 | 祖先链已加重试；但 `loadProcessInfo` 的 15s 超时未加重试——冷启动 WMI 未预热时首屏可能整列「未知进程」且拒绝结束，刷新一次即可 |
| UDP 端口 | 设计上只列 TCP（README 已写） |
| 一条 Docker 端口两行 | 设计如此（`0.0.0.0` 与 `[::1]` 是两个真实监听），已写进 README |
| CI 三平台 | 文件已写好，**尚未在 GitHub 上真正跑过一次**（本机只能验证 Windows 腿） |

---

## 8. 临时脚本（可随时删除）

本轮的验证脚本都在 `%TEMP%\pk-verify\`：

```
kill-windows.mjs          真机 kill 链路 19 项
docker-windows.mjs        Docker 归因原始输出
docker-after-fix.mjs      Docker 可达 / 不可达 两态
encoding-and-cost.mjs     非 ASCII 命令行 + 扫描耗时
settings-windows.mjs      设置读写（DSH_HOME 指到临时目录）
debug-watcher*.mjs        watcher 夹具的调试过程
suite-*.log               各轮测试日志
```

它们不属于仓库，删掉整个目录没有副作用。

---

## 9. 工作树快照（写本文档时）

```
 M README.md
 M client.js
 M host.js
 M platforms/parse.js
 M platforms/win32.js
 M test/client-render.test.js
 M test/host-kill.test.js
 M test/host-parse.test.js
 M test/platforms.test.js
 M test/settings.test.js
?? .github/workflows/test.yml
?? HANDOFF-2026-11-15-windows.md

 README.md                  |   8 +-
 client.js                  |  19 ++++-
 host.js                    |  68 ++++++++++++---
 platforms/parse.js         |   7 ++
 platforms/win32.js         |  56 +++++++++---
 test/client-render.test.js |   4 +-
 test/host-kill.test.js     | 207 +++++++++++++++++++++++++++++----------------
 test/host-parse.test.js    |  14 +++
 test/platforms.test.js     |  34 +++++++-
 test/settings.test.js      |   5 +-
 10 files changed, 318 insertions(+), 104 deletions(-)
```

新增的两个文件不计入上面的 `git diff --stat`。
