# 用户视角检查点

## 2026-09-22 — Workspace overflow and machine snapshot placement

- Reproduced missing desktop overflow, mobile picker and machine snapshot in
  browser regressions before implementation. Workspace tabs now fold by measured
  width, retain the active workspace, and expose a searchable Basalt popover.
  Mobile uses a current-name picker. Keyboard, IME, draft and socket boundaries
  are covered. A full-suite resize case caught a picker reopening after growing
  then shrinking; the availability transition now clears its open/search state.
- Removed the separate top machine-name/status card. Existing machine resources
  appear below task cards, from the same frozen on-entry/manual-refresh snapshot.
  Missing and historical data stay explicit; no new telemetry, persistence or
  continuous rendering is introduced. Synthetic desktop dark/light and mobile
  screenshots were inspected.
- Actual loopback Worker/Herdr preview verified task cards, machine resources
  below tasks, retained terminal colors and the mobile picker, with no document
  overflow or page errors. Resize retained one realtime connection. The isolated
  verifier suppressed control/input requests and sent zero terminal input. No
  collector restart, authentication/D1 mutation or cloud deployment occurred.
- TypeScript/lint/build pass. Unit/API: 114/115 pass; the inherited Node 24.13.0
  environment-proxy fixture still times out. It was not changed or excluded.
  Full browser revalidation after the resize correction: 113 passed, with nine
  viewport-specific cases skipped only in the opposite viewport. The overall
  check gate is not claimed green because of the unchanged proxy test above.

## 2026-09-22 — Machine-first navigation and desktop workspace follow-up

- Separate follow-up to PR4: root selects the first available machine once,
  machine navigation leads the sidebar, and explicit fleet overview has its own
  route so refresh/back/forward cannot force it back to a machine.
- Desktop workspace uses an opaque snapshot sidebar with responsive one/two-card
  columns and the existing realtime controls on the right. Workspace tabs switch
  in-place; previous subscriptions close, drafts do not carry across workspaces,
  and back/close controls remain available. Mobile keeps a single detail column.
- Reproduced the working-hint/no-native-execution-evidence activity gap. The
  fallback is activity only, not delivery verification; failures retain priority
  and stale/unavailable data stays unverified. A live read-only sample already
  had native running evidence, so the earlier user-visible instant is not claimed
  reproduced from that sample. TypeScript/lint/build pass; 108 browser tests pass
  with four viewport-specific skips. Unit/API: 113/114 pass; the unchanged Node
  24.13.0 proxy-fixture timeout remains, with no test exclusion or timeout change.
- Desktop dark/light and mobile fixtures were visually inspected. Real loopback
  preview confirmed default machine selection, a two-column snapshot, exact pane
  routing and in-place workspace tabs with zero input messages, page errors or
  overflow. Only one local snapshot was refreshed for this verification; no
  persistent collector, production service or cloud deployment was changed.

## 2026-09-22 — Current task navigation and snapshot freshness

- Current tasks match realtime sheet/header geometry; cards open their exact
  realtime pane/tab, and missing targets cannot silently control another pane.
- Entry/manual refresh reads and freezes the latest uploaded overview. Snapshot
  and read times, lag/error messages, canceled-read protection and Access expiry
  remain explicit; no new collection, Manager, schema or storage is introduced.
- Regressions cover desktop/mobile geometry, navigation, frozen data, refresh
  failures, canceled responses and authorization expiry. Public-branch TypeScript,
  lint/build and 98 browser tests pass. Unit/API: 112/113 pass; the unchanged
  upstream environment-proxy fixture times out on Node 24.13.0 (CONNECT support
  is absent). No test was excluded, and the full gate is not claimed green.
  No deployment or real terminal input is part of this contribution.

## 2026-09-22 — Default input control requested on opening realtime

- User superseded the earlier read-only default: a fresh realtime view now
  requests input control once, after the bridge is online and a target exists.
  Input remains gated by the server's single-controller grant. Denial, explicit
  release, target replacement and reconnect do not trigger automatic retries;
  drafts still clear and uncertain inputs never replay.
- First reproduced the disabled default in desktop/mobile regressions. Updated
  release/reacquisition and delayed/denied-grant checks, retained terminal
  replacement and reconnect protections, and aligned the real verifier/docs.
  All 96 unit/API tests, TypeScript, lint/build and 84 browser tests pass.
- Actual local Herdr preview on desktop/mobile granted one default request and
  disabled input after explicit release, with zero input messages or page errors.
  No terminal commands, production deployment or collector/bridge restart occurred.

## 2026-09-22 — Compact terminal footer spacing

- Moved visual separation above the recognized idle Codex model/directory
  footer: one blank line after output, no trailing blank lines or extra bottom
  padding. Ordinary screens and typed input retain their existing spacing.
- Regression tests first reproduced the missing separator; all 96 unit/API
  tests, TypeScript, lint/build and 80 desktop/mobile browser checks now pass.
  Retained style runs and original terminal frames remain unchanged.
- Read-only verification against the real local Herdr preview confirmed the
  separator, zero bottom padding, styled output, bottom-follow and no page
  overflow or errors on desktop/mobile. No control lease or terminal input was
  sent. Existing collector/bridge and production deployment are untouched.

## 2026-09-22 — Consolidating realtime UI work into PR2

- User superseded the earlier separate-PR request: all UI work belongs in PR2;
  PR3 is to be closed after the consolidated PR2 update is verified and pushed.
- Combined existing styled text/themes/follow behavior with first/default
  read-only realtime, an inline icon/target row, and narrowly scoped idle Codex
  footer cleanup. Removed the superseded separate output-status row rather than
  rendering two indicators. A regression verifies retained body/footer colors
  and that original frames are not mutated.
- Full gates pass95unit/API tests, TypeScript, lint/build and80desktop/mobile
  browser tests. Synthetic mobile screenshot visually confirms colors, first
  realtime tab and one compact icon/target row. No production change or terminal
  input is authorized by this consolidation; local preview readback follows.

## 2026-09-21 — Realtime terminal contribution in isolation

- New regressions reproduced missing colors and the initial/top-follow scrolling
  defect. Desktop/mobile fixtures now cover follow, pause, resume, replacement
  reset, escaped text and activity semantics. Synthetic terminal parser tests
  cover redaction across SGR boundaries, OSC/clipboard removal and payload bounds.
- A real isolated Miniflare/DO test first reproduced rejection of styled format
  negotiation. Compatibility work now keeps legacy viewers/agents on plain
  frames and explicitly opts new peers into validated style runs.
- Full gates passed: 86 unit/API tests, TypeScript, lint/build and 70 browser
  tests. Desktop/mobile dark/light fixture screenshots were generated; mobile
  dark and desktop light were visually inspected. Input controls, reduced motion,
  bounded layout and existing realtime security/lifecycle regressions pass.
- No real terminal was inspected/controlled and no production service/config was
  changed. Real local/public terminal roundtrip verification was not performed;
  it must be run from a permitted Herdr environment before release. No package
  was published and no production deployment is implied by these checks.

## 2026-09-20 07:14 +08 — Space realtime local round trip

- Actual Herdr 0.9.1 socket collection and machine-Bearer upload reach the local machine DO. The real local site renders live Space layout and terminal text; a browser-controlled temporary shell printed the verification marker and returned it in 822 ms.
- Four enter/leave cycles opened and closed four WebSockets. Fixed a missing DO close-handshake acknowledgement found by this real test. Unsubscribing also aborts bridge socket reads/timers; replaced terminals and duplicate input are rejected in isolated tests.
- Access/Origin checks, exclusive control and credential revocation pass with real isolated Miniflare/DO/D1. Raw snapshots still do not append D1 history; realtime terminal/input content has no storage path.
- `npm run check` passes. Next hops: full browser suite, same-project Codex pane review, production bridge/service deployment, real local/public `verify-live.ts` and `verify-realtime.ts` receipts.

## 2026-09-19 13:58 +08:00（15 分钟）

- 用户可访问 https://eagle.dev.hexly.ai（Caddy → 6001 Vite → 36001 Worker），HTTPS 200，私密登录已可用。
- 真实采集覆盖本机 15 Space、30 Pane；完整布局、Codex 最终回复/Goal、Git、前台进程已形成 v1 report，没有采集缺口。
- 16 项 Schema/判断/Worker D1/采集测试通过；4 项桌面/手机浏览器行为测试通过。
- 本轮发现的真实阻断点：dotenv 的嵌套 JSON 转义、Wrangler dev 不热更新 secret。已用单引号写入安全配置，并重启本项目 dev Worker。继续用真实上传与浏览器验证修复效果。
- 不把测试通过或 Herdr 的 done 当发布完成。下一检查点核对：认证上传 → D1 中的真实清单 → 页面全量 Space → 无手动刷新更新。

## 2026-09-19 14:13 +08:00（30 分钟）

- 生产 https://eagle.hexly.ai 已部署；`/api/live` 返回 Git revision 0d83f3699c3797c3eeadb5e524c508b7cdefd6c5。
- 14:09 生产真实验证通过：本机 15 Space、30 Pane，采集 → Bearer 认证 → D1 → 桌面/手机页面，全量清单一致；重复上报、自动刷新、详情、历史、匿名 401 均验证成功。
- 首屏已加入最近变化和最近采集摘要；完成数不包含失去心跳或采集过期的快照。原始终端摘录只在证据详情使用。
- Grok 只读 Review 指出的旧任务重绑定、告警被心跳清除、停止 Session 的历史拓扑和坏 spool 阻塞问题，已逐项添加失败用例并实现修复。Origin 403 推测未在真实 HTTPS 链路中复现（多次实际登录成功）。Pi 因连接错误未提供有效 Review。
- 正在跑修复后的全套检查，然后更新生产并配置本机定期上报。最终验收仍以新版本的实际线上数据为准。

## 2026-09-19 14:22 +08:00（发布收尾）

- 14:14 本地、14:15 生产真实端到端验证通过，均为 15 Space、30 Pane。匿名拒绝、私密登录、幂等上传、D1 清单、全量页面、自动刷新、历史和手机布局全部通过。
- 生产本机 LaunchAgent 已持续按 30 秒间隔成功上报，无采集告警或错误日志；页面每 5 秒更新。其它物理机器尚未接入，复用 Skill 和接入文档已提供。
- `21e55da` 的 GitHub CI 全绿；Grok 确认实际 HTTP 400 → UploadRejectedError → spool 隔离路径闭环，无剩余该项 P0/P1。
- 最终恢复检查新增了两个先失败的用例：成功 HTTP 响应缺少有效入库回执时保留报告；1000 条积压队列先重传再采集。修复后 31 项单元/集成测试通过，6 项桌面/手机浏览器测试通过。正在核对完整发布检查和最终部署版本。

## 2026-09-19 · Identity and Hexly onboarding checkpoint

Prepared in an isolated checkout while the original checkout's Access migration
continues independently. The golden eagle is installed in README, transparent
sidebar (expanded/collapsed), loading/login marks and seven-resolution browser
ICO. GitHub → Hexly → Theme controls share Basalt tooltips. Existing business
credentials and reporting data are unchanged by this batch.

A real Miniflare/D1 check first demonstrated the missing public health version;
the endpoint now reads the root package version and retains dependency failure,
no-store, revision and anonymous-read semantics. 31 API/agent/unit checks and
8 desktop/mobile browser cases passed. Browser fixtures are test-only; these
results are not a claim of real-machine or production verification. Next hop:
merge current published authentication changes, then verify actual local/public
serving and the first catalogue-derived production Cron observation.


## 2026-09-19 15:16 +08:00（Access 与视觉改版，15 分钟）

- Access 签名、issuer、audience、过期和旧凭据拒绝测试已通过；本地免登录严格限定开发开关与本地主机名。Grok 只读认证 Review 未发现 P0/P1。
- 真实 Herdr 采集仍为 15 Space / 30 Pane；15:16 本地无登录端到端验证通过，覆盖认证上传、D1、幂等重传、全量 Space、自动更新、详情、历史及桌面/手机渲染。
- 本地检查发现 Wrangler 默认把 hostname 设成生产域名，已设置 dev.host；Vite 测试/开发服务共享缓存导致真实页面 504，已隔离缓存。上述修复均经过真实浏览器复验。
- 视觉重构已实现紧凑机器分组、Space 拓扑、状态筛选、变更节奏、Agent 分布、证据覆盖和骨架加载；8 项桌面/手机交互测试通过。正在检查真实数据下的最终排版。
- 公网现有 Access 同时阻断原机器上传；独立 eagle-ingest.hexly.ai 入口已补失败用例并实现，只开放 Bearer 上报/心跳与健康检查，其余路径 404。尚待部署。
- 已发起真实 Access 登录，等用户在浏览器完成认证后执行生产认证页面验收；不请求用户提供 Token。


## 2026-09-19 15:24 +08:00（发布前复核）

- 最终门禁：33 项单元/集成测试、10 项桌面/手机浏览器测试、TypeScript、Biome、生产构建全部通过。
- 15:23 本地真实免登录端到端复验通过。自动更新通过 machine-heading 的语义 time 元素核对精确 capturedAt，避免误把页面时钟当作新快照。
- 首屏采用彩色状态指标、需关注/进行中优先的紧凑 Space 拓扑、右侧变化流与证据覆盖；多 Tab 并排展示，手机统计收为一行。动效支持 reduced-motion，后台刷新保留内容。
- Grok 确认专用 ingest host 没有可复现绕过。其停止 Session 计数推测已通过 summarize 实际运行反证：即使 Pane 的证据齐全，unavailable Space 仍为 unverified。
- 正在部署，并将本机上报入口切换到专用域名、清理旧 viewer secret。真实 Access 用户登录尚待完成。


## 2026-09-19 15:31 +08:00（Access 改版，第二个 15 分钟）

- 已整合 main 上独立发布的鹰标识、品牌链接和健康版本字段，保留双方变更；Grok 已收回停止 Session 的误报，无可复现 P0/P1。
- 15:30 本地真实免登录端到端复验通过：当前 Herdr 为 14 Space / 28 Pane，采集、Bearer、D1、全量渲染、自动刷新、详情、历史、桌面与手机均通过，无浏览器错误。
- 冷启动测试发现 Vite 延迟发现 Radix 的 react-dom peer 导致依赖 504，已预加载该依赖；清空测试缓存后的 12 项桌面/手机用例通过，33 项单元/集成测试及类型、Biome、构建通过。
- 真实 Access 用户登录已成功。旧 VIEWER_TOKEN 已从 Worker secret 和本地安全配置删除，机器 Bearer 保留。
- 当前生产断点：新增采集域名尚未可解析；积压快照仍安全保留在 spool。正在核对域名绑定并部署整合后的确切提交，再验证生产登录与补传。


## 2026-09-19 15:40 +08:00（真实生产验收）

- `fcadf5d` 已推送 main、GitHub CI 全绿并部署；真实 Access 会话在 15:37 完成生产端到端验证。14 Space / 28 Pane 从真实 Herdr 采集，经机器 Bearer、D1 到桌面/手机全部渲染；幂等、自动刷新、详情、历史及无浏览器错误均通过。
- 生产匿名看板请求 302 到 nocoo Access；独立采集域名的页面、资源、overview、history 均为 404，未认证 reports/heartbeat 为 401。公开健康检查包含 0.1.1 与完整 Git revision。
- DNS 问题来自 Mihomo 和系统的负缓存；清理 Mihomo 缓存后公网解析正常，Node 采集器已跟随本机现有 HTTPS 代理。spool 已清空，15:38:12、15:38:42、15:39:12 连续成功上报，均无采集告警，错误日志没有新增。
- Worker 只剩 AGENT_TOKENS secret；旧 viewer 文件及安全 JSON 字段已删除，机器安全配置保持 0600。
- 最终复核新增失败用例：请求失败不得继续显示“已同步”。桌面和手机均先复现，随后改成红色断线提示并保留上次快照；正执行最后复验与部署。

## 2026-09-19 16:06 +08:00（侧栏框架，本地预览）

- 参照 Ellie、Giraffe，桌面侧栏默认展开，PanelLeft 控制折叠，底部使用 Basalt SidebarUser / Avatar 展示账户与退出登录。真实浏览器确认两种状态的 Logo 均为 x=22、y=16、24×24；手机抽屉开关、真实头像加载及本地退出不可用均通过。
- `/api/v1/me` 从验证后的 Access JWT 获取邮箱，以 SHA-256 查询既有头像服务，不转发凭据、不入库。本地通过安全配置指定预览邮箱，仍然无须登录。服务失败回退姓名和首字母头像。
- 16:04 本地真实端到端通过：12 Space / 21 Pane，从 Herdr 采集、Bearer 上传、D1 到全量页面；幂等、自动刷新、详情、历史、桌面和手机均通过，无浏览器错误。16:06 本地每 30 秒采集已启动，首轮成功，无采集告警。
- 新增测试先复现旧侧栏行为、缺失身份接口及发布 CSP 阻止外部头像，再完成修复。最终 34 项单元/集成、18 项浏览器测试、TypeScript、Biome 与构建通过。
- 已打开 https://eagle.dev.hexly.ai。此次按要求交付本地预览，尚未将该批框架改动部署到生产。

## 2026-09-19 16:31 +08:00（端口纠正、机器资源与关注端口）

- 查询 nmem 确认 6001 属于历史 eagle-webui，最新项目序列为 Archy 7051、Zeppelin 7052。核对注册记录、两份 Caddyfile 和可绑定性后，为当前 Eagle 分配 7053 / 37053（Worker）/ 38053（inspector）/ 17053（API E2E 预留）/ 27053（浏览器）。项目配置、文档、活跃及 workflow Caddyfile 已同步；Caddy validate/reload 与 HTTPS 200 通过，分配记录写入 nmem `eagle-local-ports`。
- 16:21 直接 SQL 核验：线上 Cloudflare D1 `eagle` 已有 235 份报告，最近写入 16:21:16；独立本地 D1 当时有 60 份报告。生产原有采集持续运行。
- 采集器增加 CPU 使用率/型号/核数/负载、内存、主目录文件系统容量/可用空间和 uptime；`watchPorts` 可配置最多 32 个本机 TCP 端口，已在本地启用 Raven 7024。当前真实探测为未监听，不等同于线上 Raven 服务状态。
- 16:30 本地 D1 SQL 直接读出最新快照的 18 核、128 GiB、Raven 7024 与 closed 状态。新增字段保存在原有 reports.payload，无需表迁移；旧 v1 报告仍有效，缺失/过期数据不显示为当前正常。
- 16:30:55 真实端到端验证通过：11 Space / 20 Pane + 资源和关注端口，从采集、Bearer、幂等、D1 到全量页面/历史/自动刷新与桌面手机均通过；无页面错误或横向溢出。38 项单元/集成、20 项浏览器测试及类型、Biome、构建通过，新增用例先失败后实现。
- 本地持续采集已恢复，预览域名不变。此次未部署新增字段；发布顺序已写入 Agent 文档：先部署兼容 Worker，再重启生产采集器。

## 2026-09-19 16:45 +08:00（每机 DO 当前状态，本地验收）

- 按最新指示暂缓每小时总结及 D1 归档，本轮没有新增 Cron 或 D1 Migration。已有历史只读保留。每台已配置机器对应一个 SQLite Durable Object，保存当前全量快照、心跳、告警、revision 和最近一次变化摘要；回执只存 ID、摘要哈希和序号，不存历史报告。
- 严格 TDD 先复现上传仍写 D1、首页依赖历史、队列先补旧状态，以及健康接口缺失新存储标识，再完成实现。42 项单元/集成测试和 22 项桌面/手机浏览器测试通过；类型、Biome、构建通过。覆盖 DO 驱逐恢复、并发首次上传、重复/冲突、乱序、Space 关闭、告警保留和旧历史表不可用时当前链路仍正常。
- 16:44 真实本机 11 Space / 20 Pane 的端到端通过：Herdr → Bearer → DO → 页面，资源、Raven 7024、自动刷新、稳定 DOM、Pane 证据、既有历史和手机布局均验证；无浏览器错误。Raven 7024 当前仍未监听。SQL 复核本地 D1 前后均 83 条，最后写入仍为 16:36:50，说明新上传未进入 D1。
- 首页直接读取 DO 当前变化，取消按报告刷新 D1 历史。仅首次加载显示骨架，刷新保留原卡片；进度条延迟出现，拓扑位置平滑过渡，减少动画偏好生效。Agent 队列优先最新快照，旧上报不能回滚 DO。
- 下一步：部署已验证的当前状态架构，先发布兼容 Worker，再更新并恢复生产 Agent，验证真实 Access 和线上 DO。

## 2026-09-19 17:08 +08 — 本地总览分层与 Connect

- 用户视角：全局页只展示全部机器汇总、状态分布与资源图；进入机器后展示资源、端口与 Space，顶部汇总卡片不再重复。Connect 已可新增机器、生成接入提示词、重命名、轮换及停用凭证。
- 真实检查（17:07:58）：本机 12 Spaces / 21 Panes 完整采集，Bearer 认证成功，幂等重试成功，DO revision 前进，Caddy `https://eagle.dev.hexly.ai` 桌面和手机均渲染通过；刷新卡片 DOM 保持，历史查询正常且没有新增 D1 写入。
- Token 采用签名凭证，签名密钥只写入本地安全配置；每个机器 DO 仅维护凭证版本和机器配置，Token 不入库，页面预览隐藏 Token。
- 下一跳：从 Connect 生成凭证，用仓库外安装的 npm 包上报真实机器数据，验证轮换与停用。网站和 npm 暂未发布，生产采集器保持运行。

## 2026-09-19 17:20 +08 — Connect 本地验收完成

- 17:09:59 真实 Connect 验收通过：页面创建验证机、复制含一次性 Token 的提示词、仓库外安装 npm tarball、采集本机 12 Spaces / 21 Panes 并写入独立 DO；轮换后旧凭证 401，新凭证仍能上报，停用后新凭证也返回 401。桌面和手机无浏览器错误或横向溢出，预览不显示 Token、浏览器存储无凭据。
- Grok 只读 Review 提醒轮换时保留已有配置；已将关注端口纳入机器配置，提示词明确核对 machineId 后仅替换 Token，禁止覆盖 evidenceFile、端口及其它设置。集成者另外补测旧机器迁移：移除旧 AGENT_TOKENS 配置后仍能从独立机器目录找到已迁移机器。
- 最终本地 45 项单元/集成、26 项桌面/手机浏览器测试、TypeScript、Biome、构建全部通过。npm 包在临时目录独立安装并运行 init/帮助已通过，实际 npm 安装包的上报链路也已验证。
- 17:17 SQL 复核：本地 D1 仍为 83 条，最新写入仍为 16:36:50.785。新机器管理和当前状态没有写入 D1。测试机器已停用，本地正式采集恢复每 30 秒运行，生产 LaunchAgent 未停止或更新。
- 网站与 npm 包都保持本地预览，未部署或发布。

## 2026-09-19 17:31 +08 — Agent npm 首次发布

- `@nocoo/eagle-agent@0.3.0` 已公开发布到 npm，发布源码为 `23880d7`。精确 tarball 只包含 6 个编译后的 JS 文件、package.json 和安装说明；官方 registry 的 SHA-512 integrity 与发布前检查的包一致。
- Connect 提示词、npm README、仓库安装文档和 eagle-report Skill 已写明 Node 24+ / Herdr 前提、官方源下载、npm 连不上时首选腾讯云 HTTPS 镜像、固定版本验证及镜像同步延迟处理。只对单条命令指定 registry，不改全局配置。
- 官方源以全新缓存独立安装成功；腾讯镜像已同步 0.3.0，校验值一致，未使用 npm 登录凭据的全新全局安装也成功。两种安装的 `--version` 均为 0.3.0，`--help` 正常。
- 17:30:17 从官方 npm 下载的 Agent 完成真实 Connect 验收：本机 11 Spaces / 20 Panes，经签名 Bearer 上报到机器 DO；轮换后旧 Token 401，新 Token 能上报；停用后新 Token 401。Raven 7024 配置保留，桌面与手机渲染、浏览器无凭据持久化均通过；验证机已再次停用。
- SQL 复核本地 D1 仍为 83 条，最近写入仍为 16:36:50.785，新上报没有写入 D1。新增提示词检查先失败再通过；45 项单元/集成/安装测试、26 项浏览器测试、类型、Biome 和构建全部通过。
- 本轮只发布 npm Agent。网站改动继续在 https://eagle.dev.hexly.ai/connect 预览，Worker 未部署，生产采集服务未更新。
- 首轮 GitHub CI 揭示移动端刷新测试把尚未结束的 2px 悬停动画误判为布局变化；测试改为先把指针移到刷新按钮、等待卡片动画完成再测量，保留原来的严格坐标和 DOM 连续性断言。桌面/手机该用例各重复 5 次均通过，完整本地门禁再次通过；发布包内容未变化。

## 2026-09-19 17:58 +08 — Pane 语义通道实施检查点

- 本机真实 Caddy API 确认 11 Spaces / 21 Panes，最后快照 17:58:00；daemon → Bearer → DO 的持续链路正常。
- summary v1、task/evidence 绑定、sequence 幂等与独立 D1 摘要表已完成首轮 Miniflare 测试；采集器旧 manager 文件不能再冒充 Git/测试/部署证据。旧报告历史仍暂停写入。
- 真实语义链路尚未接通：本地 API summaries 为 0，Migration 尚未应用、Manager CLI 和页面展示正在实现。本检查点不算语义能力验收。
- 下一跳：完成持续 Manager、处理总结期间事实变化、接入 Pane 摘要与时间线，再用本机所有 live Pane 验证。

## 2026-09-19 18:13 +08 — 独立语义流与 UTC 小时契约

- 真实 Herdr 库存已变化为 9 Spaces / 18 live Panes，0.4.0 daemon 于 18:12:52 经 Bearer 成功更新本地 DO。先前 Cherry 已实际覆盖全部 18 个 live Pane，并出现 interpreted=0 的纯核对轮次，未每 30 秒调用模型。
- 按用户补充将语义历史改为 DO 独立 SQLite 记录，按 observedAt 的 UTC 小时桶分组；D1 仅作不可变副本。小时 latest/all 查询、迟到旧任务不覆盖当前任务、跨 DO 驱逐恢复、幂等与桌面/手机展开测试通过。
- 重构后的本地 DO 语义表目前为空；旧开发态总结已在 D1，新的真实 Cherry 验收尚在进行。Review 发现 cache 与 DO 缺失状态可能持续 409，已先复现再修复为缓存补传；同时修复新任务复用旧 previous 和 cooldown 的问题。
- 当前下一跳：用更新后的持续 Manager 重新填满全部 live Pane，验证 DO 小时记录→页面→D1副本，再进行完整 Review、CI 和生产发布。每小时 AI 聚合保持暂停。

## 2026-09-19 18:21 +08 — 全 Pane 本地验收与发布门禁

- 18:16 真实 Caddy 验收逐一打开 9 Spaces / 18 live Panes，18 个均有 Cherry 当前任务语义总结；每个 Pane 的 UTC 小时分组、latest/all、来源与 64 位内容哈希均核对成功。桌面/手机无溢出或脚本错误，自动刷新保留同一总结 DOM。
- 同轮原有 verify-live.ts 验证完整采集、Bearer、DO、资源/端口、幂等、自动刷新和历史读取全部通过。新语义模型有 interpreted=0 的心跳轮次；真实变化后继续产生多条小时记录。
- Grok 只读 Review 的缓存补传、旧任务 previous、409 心跳冲突与证据保留问题均已修复；语义存储改为独立 SQLite 表和已知事实索引。补充测试验证迟到观察不能回滚当前指针、latest 查询拒绝 cursor、观察超出保留期拒绝，以及含分隔符的 ID 不会串绑。
- 当前 55 项单元/集成测试、30 项浏览器测试、类型、Biome 和构建通过。生产 D1 0002 已应用，Connect 签名密钥已写入 Worker 安全配置，真实 Access 会话有效。网站与生产 Manager 的正式切换即将进行；npm 0.4.0 待发布认证。

## 2026-09-19 18:28 +08 — Review 修复与连续运行复验

- 18:28:31 再次通过真实 Caddy 验收：9 Spaces / 18 live Panes 均有当前任务总结，逐 Pane 展开 UTC 小时全部记录，核对 latest、来源、内容哈希与 sequence；桌面、手机和刷新 DOM 连续性通过。
- 真实安静 Pane w3J:p3 的语义更新时间保持 18:13:54，检查时间推进至 18:28:08，该 UTC 小时仍仅 1 条记录，证明持续 heartbeat 没有重复写历史。daemon 最近快照 18:28:03，Manager sequence 已到 42；本地 D1 副本已有 46 条、18 个不同 Pane（18:22 查询）。
- Grok 第二轮 Review 后先补失败用例：同 Pane 不同 task 可独立上报；错误条目被隔离后有效条目立即续传；当前 live task 指针不被历史保留策略清理。三个问题均已修复，57 项单元/集成、30 项浏览器测试、TypeScript、Biome、构建通过。
- 下一跳：当前修复提交通过 CI 后部署 Worker，重启生产确定性 daemon 并启用独立 Cherry Manager，验证生产 DO、D1 语义副本与全 Pane 页面。npm 0.4.0 已遇 EOTP，等待新的发布验证码；网站发布不依赖 npm 验证码。

## 2026-09-19 18:38 +08 — 生产真实 Cherry 验收

- `4a156928092969e4efa919a805ba41183b415bfe` 通过 GitHub CI（run 35437633317），部署到 https://eagle.hexly.ai；Cloudflare Version ID 为 `3e06045b-4ddf-4cc2-a830-b4ce41478c13`。线上健康接口返回相同源码 revision、semanticStore=durable-objects、semanticHours=UTC。
- 18:33:40 生产 verify-live.ts 通过真实 9 Spaces / 18 Panes 的采集、Bearer、DO、资源/关注端口、幂等、Access 登录、全 Space 渲染、稳定刷新、旧历史与桌面/手机检查。整机快照没有继续写 D1。
- 已启用独立 LaunchAgent `com.hexly.eagle-manager`，使用现有 Cherry profile；原 daemon 更新至 0.4.0 并继续每 30 秒运行。18:36:32 生产 verify-summaries.ts 逐一展开全部 18 个当前任务总结及小时记录，latest/all、source、content hash、桌面/手机与 DOM 连续性全部通过。
- 远程 D1 实查 18 条语义副本、18 个不同 Pane，最新收件 18:35:35；DO 中同一 UTC 10:00 小时有 18 条记录。安静 Pane w3J:p3 的语义更新时间保持 18:33:48，检查时间从 18:35:11 推进到 18:35:41，内容哈希不变、小时仍仅 1 条。生产曾遇短暂 fetch 断连，持久 pending 批次重试成功，没有清除状态或重新创建 sequence。
- 本机已从校验过的发布 tarball 安装 0.4.0，`eagle-agent --version` 与 manager-once / manager-watch 帮助验证成功。npm registry 的 0.4.0 发布仍被 EOTP 阻止，尚未取得新的验证码；因此其它机器暂不能从 registry 安装此版本。Skill 和安装说明已备妥，待验证码后发布相同包并校验腾讯镜像。

## 2026-09-19 18:59 +08 — npm 0.4.0 与布局预览

- npm 已接受 `@nocoo/eagle-agent@0.4.0`，官方 registry 已返回该版本；SHA-512 与此前测试的 tarball 完全一致。正在以全新缓存验证官方源及腾讯镜像安装，网站布局仍在本地收尾。
- 18:57:31 真实 Caddy 验证通过：9 Spaces / 17 live Panes，采集、Bearer、幂等上传、DO revision、CPU/内存/磁盘/Raven 7024、全部 Space 渲染与稳定自动刷新正常。桌面和手机无浏览器错误；本地 daemon 已恢复。
- 本地 D1 SQL 复核旧快照仍为 83 条，最新时间仍为 16:36:50.785，没有恢复整机快照归档。语义通道与生产 Manager 未改动。
- 用户可在机器页看到压缩后的状态头部，资源卡已移到右侧「02 运行脉搏」上方；手机资源卡在拓扑之前。按钮问题先由浏览器测试复现：保存/取消文字换行、证据按钮高度仅 16px、复制提示词缺少按钮内文案。修复后桌面/手机对应 6 项回归通过。
- 下一跳：审查多宽度按钮与实际预览，完成网站 v0.2.1 门禁、CI、部署和生产验证。
- 18:59 npm 复验完成：官方源与腾讯镜像均使用全新缓存安装成功，tarball integrity 相同，CLI `--version` 为 0.4.0，`manager-once` / `manager-watch` 均存在。`agent-v0.4.0` 已指向发布源码 `4a15692` 并推送。
- 发布前布局复查覆盖 390 / 520 / 768 / 1024 / 1280 / 1600px：修复中等宽度下固定列数挤压多 Pane 按钮的问题，按实际可用宽度自动排列 Space；真实页面所有按钮无横向内容溢出。最终 57 项单元/集成、34 项浏览器、TypeScript、Biome、构建全部通过。人工 diff Review 核对原生 Basalt 控件、Token 内存生命周期、独立复制反馈、过期提示与 DOM 连续性，未发现发布阻断项。
- 19:01:50 最终 Caddy 实测时库存已新增为 10 Spaces / 18 Panes；完整 verify-live 再次通过，daemon 恢复持续上报。

## 2026-09-19 19:11 +08 — Agent 中立接入修正

- 根据另一台机器的真实失败报告，移除隐式 `cherry` 可执行文件默认值。语义层要求显式 `manager.command`，推荐已配置的 Hermes，也支持任何满足 stdin/stdout 契约的管理 Agent；缺少配置时快速说明处理方式，不影响独立 daemon。
- Onboarding、npm README、项目 Skill 和双语文档同步说明：Cherry 是本机 Hermes 别名/profile，不能据此寻找或安装同名产品。已核验本机 Hermes CLI 参数与官方项目来源；保留原模型/provider/profile，禁用工具，其他 Agent 采用自身已验证接口或适配器。
- 两项 Manager 行为测试先失败再通过：未配置命令时不发网络请求；独立非 Cherry 子进程从 stdin 获取脱敏输入并成功上报自己的 writer ID。包测试确认 manager-once/watch 未配置时立即退出且不泄露 Token。59 项单元/集成、34 项浏览器、类型、Biome、构建及 Skill 校验通过。
- 19:10:48 真实 Caddy 验证 10 Spaces / 18 Panes，采集→Bearer→DO→资源/拓扑→稳定刷新通过，旧 D1 历史未增加。本机安全配置已显式保留原 Cherry profile 命令和 writer ID，未重置 sequence。
- 网站 v0.2.1 的布局提交 CI 已通过；曾因同一工作区正在进行 README 整理而被部署脚本拒绝，没有产生不明确的线上 revision。该文档整理现已单独提交。新的 Agent 0.4.1 包已准备并等待 npm OTP；本轮修正提交通过 CI 后部署网站。
- 19:14:09 生产语义复验逐一展开 18/18 live Pane 与 UTC 小时 latest/all，来源、内容 hash、sequence、桌面/手机、DOM 连续性全部通过。当前代码提交 `b51becd` CI 全绿（run 35439452296），Manager sequence 已持续到 66。
- npm 0.4.1 发布等待用户提供新 OTP。为独立完成网站部署，Connect 与公开安装步骤暂时固定已发布的 0.4.0，并显式配置其已支持的 manager.command；因此新提示词不依赖未发布版本。0.4.1 tarball 和源码已单独留存待发布。

## 2026-09-19 19:21 +08 — 网站 v0.2.1 发布验收

- `c19801bd65b3d0648a3f01e9ccfd6acbee365386` 已部署到 https://eagle.hexly.ai，Cloudflare Version ID `76756438-c2cb-4865-8c7d-9c9ac2a62ab9`。`/api/live` 返回 v0.2.1 和对应 revision；该提交 CI 全绿（run 35439643975）。Git tag / GitHub Release `v0.2.1` 已发布。
- 19:19:47 生产 verify-live 完成真实 10 Spaces / 18 Panes 的采集、Bearer、DO、资源和关注端口、幂等、Access 匿名跳转/会话、全部 Space、旧历史及桌面/手机验证；自动刷新保留原 DOM，整机快照仍不新增 D1 历史。daemon 已恢复并持续上报。
- 19:20:44 在新网站逐一展开 18/18 live Pane 语义总结与 UTC 小时时间线，latest/all、来源、内容 hash、sequence、 freshness 和刷新连续性全部通过。生产 Manager 沿用原 profile/writer ID，sequence 连续推进，仍出现 interpreted=0 的稳定心跳轮次。
- 线上静态资源烟测确认资源卡位于运行脉搏上方、版本 pill 正确、重命名按钮不挤压。对凭证创建响应作浏览器内桩替换以检查复制 UI，没有创建生产机器或修改生产凭证：按钮内“已复制提示词”、宽度不变、手机无横向溢出、浏览器存储无凭证均通过。实际部署的提示词为 Agent 中立、推荐 Hermes、显式 manager.command，下载固定已发布的 0.4.0。
- npm 0.4.0 已发布并验证官方/腾讯安装；0.4.1 默认行为修复已完成 59 项单元/集成和 34 项浏览器门禁，发布 tarball 源码为 `b51becd`、SHA-1 为 `df0ecee674dc8a80844b70fb94f58800aae65ef9`，仍等待新的 npm OTP，尚未声称发布。
- 已设置发布后 5 分钟 CI 复查；本轮网站部署完成，npm 验证码待补。

## 2026-09-19 20:09 +08 — Sidebar lights and hourly-report baseline

- User view: dev sidebar now has glowing online/stale/offline indicators in expanded, collapsed and mobile layouts; 38 browser checks passed before hourly-report work.
- Real local path verified at 20:08:45: 10 Spaces / 19 Panes collected, Bearer upload accepted into the machine DO, duplicate upload idempotent, resources/ports rendered, auto-refresh kept DOM stable. Local viewing remains token-free.
- D1 old whole-snapshot writes remain paused; local migration 0003 adds a separate AI hourly-report archive. No model is configured yet, so generation explicitly skips.
- Next hop: finish next-ai settings/report UI, exercise complete generation and retry against isolated Miniflare/D1, then review and release v0.2.2. Evidence: `.local/hourly-baseline-live.log`.

## 2026-09-19 20:27 +08 — Hourly report flow and dev preview

- Dev user view: Basalt AI settings and Chinese report history render on desktop/mobile; all 42 browser checks passed before final review fixes. Hour reports keep expanded content mounted on refresh.
- Real local upload and initial rendering succeeded (10 Spaces / 19 Panes). A refresh assertion raced the running daemon, so the verifier now accepts the submitted timestamp or a newer one while requiring revision advancement and stable DOM. The corrected real verification passed at 20:28:10. Legacy D1 snapshot writes are still paused.
- Migration 0003 is applied locally. `verify-hourly.ts` confirms the real settings API is non-secret, unconfigured generation skips, and D1 hourly history is queryable. A configured provider simulator with real Miniflare/DO/D1 verifies independent semantic times, concurrent leases, same-hour upserts, late input, upstream failure and protected generated-result retry.
- Grok read-only review found chronological pagination, catch-up cadence, partial-report validation, pending retention and deferred-result messaging issues. Corrected; final regression and v0.2.2 release verification follow. No production AI credential has been configured.

## 2026-09-19 20:38 +08 — UI credential storage and final local verification

- Following the user's clarification, Settings now saves/replaces/tests/clears API keys in the browser form, without returning plaintext or storing it in browser persistence. AES-GCM ciphertext lives in the directory DO's independent credential record; the wrapping key lives in Worker secrets. Changed provider/endpoint cannot reuse the previous key.
- TDD first reproduced rejection of UI key saves. The final 66 unit/integration tests and 44 desktop/mobile browser tests pass, including raw SQLite inspection for absence of plaintext, authenticated encryption, DO eviction recovery, draft testing without saving, endpoint binding and hourly generation using the saved credential.
- Real Caddy verification at 20:38:16 saved a temporary validation credential through the page, reloaded its configured status, cleared it and restored the original settings, without calling an AI provider. It also verified unconfigured skip, D1 hourly queries, settings/history rendering and mobile layout. The first attempt identified a dev Worker missing the new wrapping-key binding; restarting it resolved the failure.
- At 20:38:22, real Herdr collection again verified 10 Spaces / 19 Panes through Bearer, machine DO, resources/ports, all-Space rendering and stable automatic refresh. Raw D1 snapshot writes remain paused. Next: finish credential review, apply production migration, release v0.2.2 and verify both real production paths.
- Credential review follow-up: reproduced and fixed saving a provider key that also exists in a legacy environment binding; expanded credential binding to protocol/authentication changes and delete cleared records explicitly. Settings/ciphertext already commit together in one synchronous transaction. Kept substring credential rejection and fail-closed behavior for unreadable encrypted credentials; swallowing decrypt errors during ingestion would bypass the no-plaintext-credential guard. Production had no legacy AI key and received a new wrapping key without overwriting any existing one.

## 2026-09-19 20:47 +08 — v0.2.2 production verification

- Released commit `057e2fa` as v0.2.2; CI `35443677101` and the five-minute follow-up passed. Cloudflare version `95ced5c4-6b64-480d-ae56-e9acb3c52943`, migration 0003 and hourly Cron are deployed.
- Real production verification passed Access/Bearer authentication, 10 Spaces / 19 Panes, all live Pane semantic histories, resources/ports, idempotency, stable refresh and desktop/mobile rendering. Settings credential save/reload/clear was tested before the user configured real AI. Evidence: `.local/hourly-production-{live,settings,summaries,d1}.log`.
- D1 contained 167 semantic records; raw snapshot writes remained paused. Hourly reports were empty because no AI provider was configured at verification time.

## 2026-09-19 20:57 +08 — Configured dev AI baseline

- User-saved dev credentials remain unchanged; real connection test succeeded. Deterministic collection continues through Bearer into the local machine DO (10 Spaces / 19 Panes). Historical semantic input is separate; no currently running local Manager is implied.
- Four real-model controlled baseline cases returned valid schemas but overlong summaries and repetitive caveats. Sparse sampling was incorrectly described as brief/continuous; malicious instructions were ignored but echoed. A corrected timestamp rerun exposed another malformed JSON response.
- Real closed-hour generation (UTC 10:00, 51 semantic records, no factual snapshots) failed before D1 insertion. Diagnostic replay confirmed the first of three input chunks reached the 8,192 output-token limit; partial JSON was not archived. Next hop: concise evidence-bound prompt v2, explicit truncation detection, template-aware regeneration, then real D1/UI verification.

## 2026-09-19 21:12 +08 — Larger real inputs and bounded summary handling

- Real Caddy collection/rendering passed at 20:59: 10 Spaces / 19 Panes, resources/ports, Bearer ingestion, DO revisions and stable refresh. User AI settings and encrypted credentials remain untouched.
- The first eight revised controlled responses passed automatic format/reference checks, but manual rereading caught an ambiguous done-label paraphrase. Fixed with explicit label-only wording. Large real input then exposed oversized partial summaries and another token-truncated block; none were archived.
- Intermediate blocks now use concise evidence notes instead of a full executive report. Only a valid report with an oversized executive summary may receive one additional compression call; the remaining sections stay identical, references are rechecked, and invalid JSON/evidence or truncated responses are never repaired into an archive.
- An asset rebuild interrupted one dev request; after confirming its 503 termination, only that local unfinished lease was released. A brief upstream connection failure was separately reproduced, then the connection recovered. Next hop: rerun real closed-hour generation without rebuilding the watched dev assets and inspect D1/UI.

## 2026-09-20 05:50 +08 — Real dev archive and semantic evaluation

- After resuming the interrupted task, all 69 unit/API checks, types, Biome and build passed afresh. At 05:41:38 the actual Caddy path again verified 10 Spaces / 19 Panes, Bearer collection into the machine DO, CPU/memory/disk/ports, idempotent uploads and stable desktop/mobile refresh. Raw snapshot D1 writes remain paused; user AI settings and encrypted key are unchanged.
- UTC 2026-09-19 10:00 generated successfully in the real dev Worker at 05:41:50 from 51 semantic records across three chunks. Local D1 contains one report; repeating the request returns `unchanged`. At 05:42:35 all seven sections rendered through Caddy, expansion survived refresh, mobile had no horizontal overflow, and no browser errors occurred. These historical semantic records include DO-attached deterministic Git/process evidence despite having zero hourly factual snapshots.
- Manual reading found v2 incorrectly promoted a previous-day CI queued final-message to a current unresolved blocker. A new controlled case reproduced this despite passing schema checks. Prompt v3 explicitly retains nested evidence timestamps, treats stale blockers as unverified history, and respects cancelled tasks; the new case now meets the manual rubric. Real regeneration is underway.
- Grok read-only review found an endpoint-binding gap in the dev eval tool. A failing regression demonstrated it; shared credential decryption now requires the expected endpoint, protecting both callers. The first attempt on the larger UTC 12:00 input (123 snapshots, 594 compact records) failed inline-citation validation and did not write D1; diagnostic replay is checking the larger input without weakening validation.

## 2026-09-20 06:00 +08 — Real-time path during large-hour generation

- v3 semantic-hour regeneration succeeded at 05:51:18; all 18 distinct Pane/task identities and valid references are present, with a 301-character summary. Repeating the request is `unchanged`; there is still exactly one row for this machine/hour. Caddy history validation at 05:53:04 passed all seven sections, retained expanded DOM on refresh and mobile layout.
- The large factual-hour replay exposed a valid inline citation omitted from the declared index. After a failing regression, the parser now adds only IDs verified against the original input, without changing prose or another model call; unknown IDs still fail. Grok reviewed this change without blockers.
- Another real large-hour run hit the 8,192 output-token ceiling and was rejected before D1. Increased the existing ceiling to 16,384 while preserving 90-second call/10-minute report budgets, zero SDK retries and strict JSON/evidence validation; sanitized failure logs now identify the chunk/final stage. Full 69-test check, types, Biome and build pass; 44 browser checks passed. The larger hour is rerunning.
- At 06:00:12, actual inventory had grown to 11 Spaces / 20 Panes. During report generation, real collection → Bearer → DO → resources/ports → Caddy desktop/mobile and stable refresh all passed. Ten local overview reads took 9–28ms. Old raw-snapshot D1 writes remain paused; user AI configuration is unchanged; production is not deployed in this dev-only task.
- At 06:04:14 the 123-snapshot / 594-record factual hour completed in 275 seconds and was archived by the real dev Worker. All 27 Pane/task identities are retained, summary length is 378 characters, and every citation validates against the original records. Both hours return `unchanged` on repeat; local D1 has exactly one row per hour. Final Caddy history verification passes with two reports, seven expanded sections, stable refresh and mobile layout. The evaluation documents remaining semantic limitations instead of treating schema compliance as proof of every conclusion.

## 2026-09-20 06:36 +08 — v0.3.0 production release

- Released `0cf6688510a82ace572b99a847477d2a86c3973a` as v0.3.0, including hourly template v3 and Basalt date/hour controls. Root package and npm lock versions agree; Sidebar and both public health endpoints return v0.3.0. GitHub Release/tag are published; Cloudflare version is `69563c29-45ce-4cb1-8ce9-5780f9503026`. No D1 migrations were pending.
- Release CI `35473584212` passed 69 unit/API tests, types, Biome, build and 48 browser tests. Regression checks cover light/dark calendars, icons, keyboard selection, local-to-UTC conversion, clear filters and scrolling through 23:00 on mobile.
- Real local collection passed at 06:30:33 and production at 06:36:19: 11 Spaces / 20 Panes, Bearer ingestion into the machine DO, resources/ports, idempotency, every Space rendered, stable automatic refresh, Access authentication in production and mobile layouts. Raw snapshot D1 writes remain paused.
- Real dev D1 still contains two successfully generated reports with all seven sections and stable expanded DOM. Production has no AI configuration and zero hourly reports; the authenticated generation endpoint explicitly skips. Existing configurations and secrets were preserved. Both production themes and viewport sizes pass the real hour-query UI checks with no browser errors.
- Sanitized verification receipts and screenshots are in `.local/v0.3.0-*`. The required five-minute post-release CI/health follow-up is due at 06:41:02 +08.


## 2026-09-20 07:30 +08 — Realtime review fixes before release

- Real local Herdr collection/authentication/DO/rendering passed with 11 Spaces / 20 Panes. The temporary shell realtime test observed an 822 ms roundtrip and four opened/four closed browser connections. Existing historical D1 behavior is unchanged; realtime screens/input are not persisted.
- Codex pane review found terminal identity races, wrapped-secret exposure, Herdr revision-zero behavior, replacement drafts and lifecycle gaps. Release remains pending while fixes and regression checks are completed. No production deployment or tag has been published.
- Next broken hop: replace non-atomic pane input with strict terminal-bound native input, then verify idle alarms, slow viewers, renewable authorization and clean Codex review.


## 2026-09-20 07:40 +08 — Bound terminal input and cleanup regression

- Strict protocol-22 AttachTerminal replaced pane input routing. Real Caddy → authenticated relay → native Herdr → isolated shell output passed at 07:38:17, with 1,323 ms observed roundtrip and four opened/four closed view connections. The temporary pane was removed; no user/reviewer pane received input.
- Wrapped-token, revision-zero screen updates, target replacement and native socket cancellation regressions pass. Realtime frames and inputs still bypass D1 and ordinary snapshot storage. Browser replacement and renewable reconnect checks pass on desktop/mobile.
- Next broken hop: the idle alarm fires and closes the DO socket, but the outer client close event does not arrive within five seconds in isolated Miniflare. Slow-viewer close exposes the same forwarding behavior. Codex is diagnosing this read-only while keyboard-mode and release documentation are completed. Production is unchanged.


## 2026-09-20 07:53 +08 — Release gates and lifecycle regression

- All 77 unit/API tests, TypeScript, Biome and build pass; all 52 desktop/mobile browser tests pass. Coverage includes idle expiration, slow-viewer output bounds, maximum-size topology attachments, target replacement, frame identity, wrapped secrets and native terminal cancellation.
- Codex isolated a workerd hibernation close issue before the first client message. Browser and bridge now send ping immediately after every connection; idle expiry and slow-viewer TCP closure pass with real WebSockets. Redundant pageshow/visibility notifications retain one connection. Custom clients that never send remain subject to the runtime issue; subscribed collection is still removed server-side.
- Independently packed Agent v0.5.0 passed real local collection/authentication, credential rotation and revocation, no D1 writes, clipboard cleanup and desktop/mobile onboarding. The verifier now reads the agent version instead of a stale literal. Final native realtime and whole-machine local verification are running on the installed tarball; production remains unchanged pending Codex Sign Off.

## 2026-09-20 08:02 +08 — Final local verification and release preparation

- The independently installed Agent v0.5.0 completed the real Caddy/Herdr realtime roundtrip at 07:52:38: 1,340 ms, four opened/four closed view connections, shell output confirmed and no browser errors. Whole-machine verification at 07:52:47 passed Bearer ingestion, durable revisions, resources, 10 Spaces / 18 Panes, idempotency, stable refresh, desktop/mobile and no new D1 history writes.
- Integrator gates passed 77 unit/API tests, types, Biome, build and 52 browser tests. The read-only Codex reviewer independently passed both gates in an isolated checkout and is finishing protocol review. Production D1 has no pending migrations.
- The user briefly paused publication for unrelated Settings screenshots, then explicitly withdrew those tasks and resumed Eagle publication. No Settings changes were made. Both READMEs now document realtime capability and the v0.5.0 GitHub Release package. Next hop: final Codex Sign Off, publish v0.4.0 and Agent asset, deploy Worker, start the single production bridge and verify both real public paths.

## 2026-09-20 08:17 +08 — Review fixes and actual connection cleanup

- Codex independently reproduced cropped private-key/title leakage, a configured-machine/token mismatch, skipped cleanup when workerd reports close code 1006, and keyboard mode changes during asynchronous identity validation. Each behavior first failed a regression check, then passed after fixes in `464da03`, `2cdf1c0` and `bf4a44f`.
- The final independently installed Agent tarball passed real local verification at 08:10:46: 1,324 ms terminal roundtrip, four opened/four closed sockets, and no browser errors. At 08:10:54 whole-machine collection/authentication, 10 Spaces / 18 Panes, durable revisions, resources, stable desktop/mobile rendering and no additional D1 history writes passed. The temporary local realtime bridge was stopped after verification.
- All 80 unit/API tests and 52 browser tests passed on the fixed application. Independent review exposed a test-only final-frame waiting race (79 frames after 20 ms, all 80 after actual receipt); the test now waits for delivery and closure within a bound. The read-only reviewer is checking the latest fixes. Production is unchanged; the next hop remains Sign Off, deployment and real public verification.

## 2026-09-20 08:29 +08 — v0.4.0 production release and realtime verification

- Read-only Codex pane `w5D:p2` signed off `6499d1b..d2545d7` at 08:24 with no remaining P0/P1/P2/P3 findings. Its final isolated run passed all 80 unit/API tests, typecheck, lint, build and 52 browser tests. The last protocol fix, `d2545d7`, encodes Ctrl+C/D/L in modifyOtherKeys mode 2; `8473be9` removes the slow-viewer test waiting race.
- Published GitHub tag/Release v0.4.0 and Agent v0.5.0, then deployed Worker version `408b2f0f-0745-435b-b50b-68c3635b5575` from `d2545d77e7f4fadfc114584d2a4ac7663b9b2e2b`. Both public health endpoints and the sidebar report v0.4.0. D1 had no pending migrations. The release asset was downloaded and matched the tested SHA-256 `044522ad3153ca78455773557e12ce652c5b0e08caaef365140f9d7eae0038ef`; it is installed globally. npm registry publication remains pending; onboarding uses the published GitHub asset.
- Final local verification at 08:21 passed with the installed package (1,327 ms, four opened/four closed connections; 10 Spaces / 18 Panes). Temporary local realtime processes were stopped. Production now has one supervised `com.hexly.eagle-realtime` LaunchAgent using the installed package and existing secure machine configuration; collector/Manager identities and state were preserved.
- At 08:27:08 the real public browser sent input only to its own temporary Herdr shell and received shell output in 1,332 ms. All four view connections closed, the temporary pane was removed and no browser errors occurred. At 08:27:23 `verify-live.ts` passed anonymous Access redirection, authenticated viewing, Bearer ingestion, resources/ports, idempotency, durable revisions, all 10 Spaces / 18 Panes, stable refresh, desktop/mobile and no additional D1 history writes.
- Release CI run `35478701391` passed on GitHub. Sanitized receipts/screenshots are in `.local/realtime-production*`, `.local/production-realtime*` and `.local/realtime-public-health.json`. The required five-minute post-deployment CI/health check is due at 08:31:08 +08.

## 2026-09-20 09:46 +08 — Local UI refinement

- New browser regressions first reproduced the missing timezone preference and absent workspace entry animation. A shared browser preference now defaults to UTC+08:00; display timestamps and hourly queries use its fixed offset. Workspace chrome uses the existing Basalt Sheet and controls; realtime is being fitted to the viewport with an internal terminal scroll and anchored composer.
- Existing realtime lifecycle and settings browser checks pass in the first affected run. The new long-screen fixture exceeded the transport's 32,000-character limit and exposed an existing invalid browser close code; isolate that regression before fixing it. Desktop/mobile visual review remains pending.
- Actual local Herdr collection and Bearer ingestion ran through the existing verifier, but browser verification failed at the local HTTPS origin. D1 behavior and production remain unchanged by these frontend edits. Next hop: correct the viewport regressions, check local proxy connectivity, then rerun the real local page verification.

## 2026-09-20 09:56 +08 — Local UI refinement verified

- Shared display preferences now default to UTC+08:00 and apply to overview/resource/credential/evidence/semantic/report/realtime timestamps, the calendar's current day and hourly filters. Preference persistence stays in the browser; source timestamps and archive boundaries remain UTC. Cross-day and half-hour regressions pass with the browser in America/Los_Angeles.
- The workspace uses the Basalt modal Sheet, grouped surface cards, explicit mode buttons and close action, sliding entry/exit and animated realtime width. Realtime has a compact header, black terminal canvas, tab/target selectors, internal output scrolling and a bottom composer. Desktop/mobile, light/dark, a 460px-high viewport, reduced motion, Enter submission and target-change cleanup pass; screenshots were visually inspected.
- Final `npm run check` passes 80 unit/API tests, TypeScript, Biome and build; `npm run test:browser` passes all 62 checks. Concurrent verification exposed the existing fixed 30ms input-delivery wait in the API test; it now waits for the actual input within a 2-second bound, retaining the same assertions. Malformed browser messages now close with permitted code 4008 instead of throwing on 1008 and leaving the socket open.
- Real Caddy verification at 09:53:20 passed Herdr collection, Bearer ingestion, 10 Spaces / 18 Panes, resources, durable revisions, idempotency, stable page refresh, desktop/mobile and no additional D1 history writes. The isolated real terminal roundtrip at 09:49:38 took 830ms; all four opened sockets closed, the verifier's shell was removed, and its temporary local bridge was stopped. Vite and the existing Worker remain available; existing production services are unchanged.
- Local Settings was also rendered and inspected against the running Worker. Sanitized receipts/screenshots are under `.local/ui-*` and browser test artifacts. No remaining broken hop was observed for this local UI task. No push, release or deployment was performed.

## 2026-09-20 10:39 +08 — Unified v0.5.0, npm authentication pending

- `fa8e6e7` unifies the website and standalone Agent at v0.5.0. Runtime and Connect versions read the root manifest; package checks enforce matching Agent metadata, root lockfile and installed CLI. Active installation guides now use pinned npm commands, and AGENTS.md requires future releases to keep versions synchronized.
- The new version check first failed on Agent 0.5.0 versus website 0.4.0. After the fix, all 80 unit/API tests, TypeScript, Biome, build and 62 browser tests passed. The independently installed artifact reports 0.5.0 and retains the secure configuration checks.
- Actual local verification at 10:34:18 and public verification at 10:35:54 passed all 11 Spaces / 20 Panes, Bearer ingestion, Access behavior, resources, idempotency, durable revisions, stable refresh, desktop/mobile and no new D1 history writes. `e664887` fixes verifier assumptions about unique Space names and concurrent collector snapshots. No input was sent to user Panes.
- Local Vite (7053), the existing Worker (37053) and one local realtime bridge are available at https://eagle.dev.hexly.ai; local `/api/live` reports 0.5.0. Production code and supervised services were not deployed or replaced.
- The prepared 14-file npm artifact is under `.local/npm-v0.5.0-19wMSP/`, sourced from `fa8e6e7`, with SHA-1 `ff4f646919cc0a1d740d90f5eb96db2d1e615c6e`. npm rejected publication with E404 and then rejected `whoami` with E401, confirming invalid local npm authentication. Browser login is pending; npm v0.5.0 publication is not claimed. Next hop: finish npm login, publish this exact artifact, and verify registry integrity and a fresh independent installation.

## 2026-09-20 10:46 +08 — npm v0.5.0 published and independently installed

- Completed npm web login and the separate publication authentication in Chrome. Published the exact prepared `@nocoo/eagle-agent@0.5.0` tarball; npm exited successfully. Both the official registry and Tencent mirror expose version 0.5.0 with `latest` pointing to it and matching SHA-1 and SHA-512 integrity.
- At 10:46:47, an anonymous installation outside the checkout, using empty npm configuration and a fresh cache, downloaded the package from the Tencent mirror and matched both artifact hashes. The installed CLI reports 0.5.0 and exposes `realtime-watch`. Sanitized evidence is `.local/npm-v0.5.0-19wMSP/registry-install.json`; no authentication challenge URL or credential is retained in tracked records.
- Source website and Agent versions remain synchronized at 0.5.0. Local dev remains available; no git push, website deployment or production-service replacement was performed in this task.

## 2026-09-20 11:37 +08 — v0.5.0 website release verified

- Released `1a1baa6969549d02930014b7a0188661145f02f3` as v0.5.0 at https://github.com/nocoo/eagle/releases/tag/v0.5.0. The release includes the exact previously published npm artifact. Website and Agent versions agree; no application source changes were needed during deployment. GitHub CI `35486161839` passed all 80 unit/API tests, TypeScript, Biome, build and 62 browser checks on the released revision.
- Deployed Cloudflare Worker version `6bfe4401-7bfb-4d9e-9558-5fafe8cc8472`. Both `eagle.hexly.ai` and `eagle-ingest.hexly.ai` report v0.5.0 and the released revision. D1 had no pending migrations; existing credentials and services were preserved. The five-minute follow-up at 11:30:51 +08 confirmed healthy endpoints and successful release CI. The previous Worker version is `408b2f0f-0745-435b-b50b-68c3635b5575`.
- Actual local collection at 11:17:32 and production collection at 11:26:51 passed 13 Spaces / 25 Panes, Bearer ingestion, resources/ports, idempotency, durable revisions, stable desktop/mobile refresh and no new D1 history writes. Production Access redirection and authenticated viewing passed.
- Real terminal roundtrips took 1,340 ms locally and 1,347 ms in production; each run opened and closed four browser connections, confirmed shell output and reported no browser errors. Verification used separate owned temporary Herdr workspaces, which were removed afterward. No user pane, including `w5D:p1`, received input.
- The deployed design passed visual inspection in desktop dark/light and mobile dark modes: version badge, black terminal, visible composer, bounded sheet and no horizontal overflow. Settings defaults to UTC+08:00. Desktop sheet closure produced socket-close events. On mobile full-page navigation, Playwright did not observe the close event; a separate server-side control probe confirmed the former controller was released within 3,359 ms including navigation, without submitting terminal input.
- The existing local production realtime LaunchAgent remains running with Agent v0.5.0. A read-only production probe found current ordinary reports for `mac-studio` (`MacStudio.LZ`) but no connected realtime bridge. Each machine needs a separate `realtime-watch` service using its collector configuration; installing the npm upgrade does not start it. Upgrade instructions are in `docs/REALTIME.md`; no remote machine configuration was changed.
- Sanitized receipts, deployment log and screenshots are under `.local/site-v0.5.0-83drj7a3/`. There is no remaining website release blocker. Connecting the Mac Studio realtime service is the remaining machine-specific setup step.

## 2026-09-21 20:04 +08 — Hourly recovery implementation

- The terminal-growth regression first failed with 120 screen records instead of four task-scoped samples. Model projection now keeps the first/latest visible screen per task, source and status, retaining every other fact, semantic change and original record ID. Raw hourly inputs remain unchanged. Template v4 explicitly discloses this sampling.
- All 82 unit/API tests, TypeScript, Biome and build pass. Resumable generation, bounded scheduling and visible retry state are the next broken hops; this input correction alone does not complete the incident fix.
- Real Herdr collection ran, but local verification could not upload because the development Worker was not running after reboot. Ports 7053/37053 were closed. Restarting the existing local services and rerunning authenticated ingestion, D1 and browser verification is pending. No certificate configuration was changed.
- Public health still reports v0.5.0 at `1a1baa6969549d02930014b7a0188661145f02f3`; production has not been changed. The user authorized deploying and publishing v0.5.1 after verification.

## 2026-09-21 20:18 +08 — Recovery checks and v0.5.1 preparation

- Real local verification at 20:06:51 passed collection of 14 Spaces / 29 Panes, Bearer ingestion, DO revisions, resource/port values, idempotency, full desktop/mobile rendering and stable refresh. Whole-machine uploads still add no D1 snapshot history. Existing development servers were restarted; the existing mkcert root was read for the verifier without changing certificate configuration.
- All 89 unit/API tests, typecheck, lint and build pass. The seven new real Miniflare regressions cover eviction/resume, more than 32 chunks and bounded reduction, scheduler fairness, late input, persisted retry delay, deterministic rejection and obsolete leases. Twelve affected desktop/mobile browser checks pass, including visible unfinished-hour state.
- A read-only remote preview applied the exact new projection to production inputs. MBP 08:00 shrank from 44 chunks / 2,049,814 characters to 24 chunks / 1,080,015 characters; its 141 semantic changes remain intact. MBP 07:00 fell from 31 to 21 chunks; the other checked oversized MBP hours fell from 47/34/37/43 to 25/21/23/27. The preview was stopped after saving sanitized counts.
- v0.5.1 preparation includes the optional-proxy fix and all report recovery work. The final release gates, exact package artifact, public deployment and real backfill verification remain pending. npm identity currently returns E401; the tested release artifact will be prepared before requesting the required browser authentication. Production remains on v0.5.0.

## 2026-09-21 20:42 +08 — v0.5.1 deployed, archive recovery in progress

- Deployed `31ab65ece258fe2995782f842710a08ebe0dfcff` as Worker version `fef9e222-08a1-4269-af79-e2d19c587a77`, with the five-minute Cron schedule. Both public health endpoints report v0.5.1 and template v4. The post-deployment follow-up at 20:39:50 confirmed HTTP 200 and the intended revision; exact-revision CI `35599230216` passed.
- Final gates passed all 89 unit/API tests, TypeScript, Biome, build and 64 browser checks. Real local verification at 20:23:29 and public verification at 20:30:34 passed collection of 14 Spaces / 30 Panes, Bearer ingestion, Access behavior, DO revisions, resources, idempotency, stable desktop/mobile rendering and no additional D1 snapshot history writes. Public hourly history verification passed at 20:33:10.
- The unchanged audit window now has Mac Studio 24/24 and MBP 13/24 archived hours, checked at 20:41:35. Both missing Studio hours and MBP 16:00 are archived under template v4. MBP 07:00 and 08:00 have durably retained all 21/21 and 24/24 chunks across two-minute turns and reached reduction; these hours are not yet archived. Other model failures are visible and retained successful chunks continue to be reused.
- The tested 14-file Agent v0.5.1 tarball is retained with SHA-1 `fed657f045af563434d4d4074964c178c2bca92f`. A fresh npm web login succeeded after the previous session was cancelled at the user's request. The next hops are final archive recovery, GitHub tag/Release, npm publication and independent public-registry installation verification. No production machine service was replaced during this deployment.

## 2026-09-22 05:58 +08 — v0.5.1 published, one report still unresolved

- GitHub tag/Release v0.5.1 points to `31ab65ece258fe2995782f842710a08ebe0dfcff`; the attached Agent archive matches the tested artifact and the publicly available npm package. Official anonymous metadata, `latest`, SHA-1/SHA-512 and an independent fresh Tencent mirror installation passed. Both npm browser authentication steps completed; no authentication is pending.
- Exact-release CI `35599230216` and documentation CI `35602476919` passed. The five-minute follow-up after GitHub publication at 05:52:55 confirmed HTTP 200, v0.5.1 and the intended revision on both public origins. Previous real local/public Herdr collection, authentication, D1/DO and desktop/mobile rendering receipts remain valid; this closeout introduced no application changes.
- Real archive queries confirm 13/14 original missing hours recovered: MBP 23/24 and Studio 24/24. The original large 07:00/08:00 MBP cases are archived with their snapshot/semantic counts preserved. Automatic Cron was captured completing three reports and preserving three deferred hours with zero failures.
- The next broken hop is MBP September 21 13:00 final composition. All 23/23 chunks remain durable. The normal diagnostic reproduced a 90-second timeout; two diagnostic-only longer-budget attempts instead reached validation and rejected a `workspaces` field above 16,000 characters. No invalid report was written, no production budget/validator was changed, and the job remains retryable with persisted backoff. The incident document records this remaining limitation explicitly.
- Temporary diagnostic previews and log watchers are stopped. The release is published and verified; complete historical backfill is not claimed. No production machine daemon was replaced as part of this cloud release.

## 2026-09-22 06:14 +08 — concise report limits

- Manager generation now has field budgets, at most three outcomes and a 600-character narrative ceiling. Versioned input fingerprints refresh old cached interpretations without resetting writer identity.
- Cloud v5 reports target 800–1,500 characters with explicit section ceilings and one citation-validated compression attempt. Discarded hours retain raw evidence, invalidate active generation and do not requeue after late input or eviction. Existing archives survive template-only changes.
- TDD reproduced acceptance of oversized Manager output, unbounded hourly fields and the original oversized-workspace failure before fixes. All 93 unit/API tests and 64 desktop/mobile browser tests passed.
- Real local verification at 06:11:56 +08 passed authenticated collection, duplicate ingestion, DO state, D1 behavior and desktop/mobile rendering for 16 Spaces / 31 Panes, using the existing mkcert root CA.
- Production audit still has one unfinished MBP hour (September 21 13:00 +08); Studio has no unfinished hours. Source data and archived reports remain intact. Production deployment, explicit cancellation and Manager restart are next.
- Release preparation uses v0.6.0: the reviewed diff from pre-change main 1b55958 is 468 additions / 45 deletions and includes an authenticated cancellation endpoint. npm identity is valid; publication has not yet occurred.

## 2026-09-22 06:19 +08 — v0.6.0 deployed and backlog cancelled

- Release/tag/source: `v0.6.0` / `493b671311825912ec14ad29a2a14af53731675f`. Exact-revision CI `35661496199` passed. Worker version `150b3a56-506f-4ad5-8592-720cff73593c`; both public health endpoints returned the matching version, revision and v5 template.
- npm publication and browser authentication completed. Anonymous official metadata, `latest`, Tencent download, SHA-1/SHA-512 and an independent clean installation matched the tested artifact. The GitHub release download also matched. The local global CLI now reports 0.6.0.
- Real public verification at 06:16:15 +08 passed authenticated collection, duplicate ingestion, DO/D1 behavior and desktop/mobile rendering. Both production history layouts display the cancelled hour. All 100 previously sampled archived reports retain their original generation timestamps.
- MBP September 21 13:00 +08 was explicitly cancelled: checkpoints were removed, status is `discarded`, and a forced generation request returned `skipped: discarded`. Its 114 snapshots, 125 semantic records and 1,179 input records remained readable. Cancellation does not recover the missing report or change its coverage.
- The local Manager restarted at 06:13:59 +08 without changing writer `cherry`. At 06:17:53, 24 new summaries were confirmed in cloud state, with 56–314 narrative characters and at most three outcomes. All three local LaunchAgents remain running.
- A non-archiving model check used eight actual current semantic records and the deployed v5 prompt/completion implementation. It completed in 15.486 seconds; all seven sections passed their budgets (165/989/347/116/227/169/164 characters including identities and citations), with eight validated references. This sample is not an archived complete-hour report; no complete-hour v5 report existed at the verification time because prior completed hours were preserved.
- Mac Studio's local Manager has not been upgraded: the existing SSH path rejected authentication. Fleet-wide cloud output limits are deployed, and the new Agent package is available for its local upgrade.
- Evidence: `.local/release-v0.6.0/`. Temporary remote inspection is stopped after verification; no authentication remains pending.

## 2026-09-21 — Cross-deployment onboarding regression

- Three prompt-contract regressions first failed: checking only the machine ID,
  leaving cross-origin cache/queue isolation unspecified, and falling back to a
  different config in background services. Connect now distinguishes rotation
  from migration and requires explicit config/spool isolation and a verified
  cutover. Published Agent behavior and wire formats are unchanged.
- This contribution uses synthetic credentials only. No real registration,
  rotation, upload, service restart or deployment was performed. Full local
  gates passed: 83 unit/API tests, TypeScript, lint/build and 62 desktop/mobile
  browser tests. This is not a claim of live deployment verification.

## 2026-09-22 — Onboarding review and upstream conflict resolution

- Integrated upstream main `789bdff` without replacing its network/proxy
  guidance. Independent review found the same-origin rotation prompt had lost
  the requirement to restart existing services; restored it for only enabled
  services using the selected config and added a failing-then-passing regression.
- All four onboarding regressions, TypeScript, lint/build and 64 desktop/mobile
  browser tests pass. Full unit/API run: 96 of 97 pass; the environment-proxy
  test times out after five seconds. The same test also fails in an isolated,
  unmodified `789bdff` checkout on Node 24.13.0. No exclusion or timeout change
  was applied; the full release gate is not claimed green.
- No real credential rotation, service restart, upload or production deployment
  occurred. Kept this contribution separate from the realtime UI PR.
