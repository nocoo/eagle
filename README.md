<p align="center">
  <img src="assets/brand/readme.png" width="128" height="128" alt="Eagle 金色鹰 Logo" />
</p>
<h1 align="center">Eagle</h1>
<p align="center">汇总多台机器上的 Herdr Space、任务证据与工作态势。</p>
<p align="center">
  <a href="https://eagle.hexly.ai">站点</a> · <a href="docs/README.en.md">English</a>
</p>

## 这是什么

Eagle 是面向 Herdr 用户的私有看板，汇总每台上报机器的 Space、窗格布局、机器资源与任务证据。缺失、冲突或过期的数据明确标记；Agent 的 `idle`、`done`、`blocked` 仅是提示，不作为任务完成证明。

## 功能

- **跨机器总览**：查看机器状态分布、资源概况与 Agent 分布，进入单台机器查看 Space、真实窗格布局、任务证据与变化时间线。
- **Space 实时模式**：通过独立机器桥接服务近实时查看终端文本和布局，接管后发送输入；切换、退出或页面后台自动回收订阅，断线输入不重放。见[实时模式与协议限制](docs/REALTIME.md)。
- **机器接入**：Connect 页面添加和重命名机器，生成一次性接入提示词，轮换、停用与重新启用机器凭据。
- **资源与端口**：上报 CPU、内存、主目录所在磁盘容量和运行时间，可检查指定本机 TCP 端口。端口监听只代表连通，不能证明业务健康。
- **任务证据**：对照当前任务总结、Goal、Git revision 和测试凭证；涉及部署时还需要部署证据。运行中的 Goal 或实际工具执行优先于表面的完成提示。
- **AI 小时报告**：设置页通过 next-ai 配置模型，默认每小时按固定中文模板总结全部工作与资源；缺少 AI 配置时自动跳过。侧栏以发光状态点显示机器在线、采集过期或心跳超时。
- **实时语义总结**：独立 Manager 为 Pane 提供任务、阶段、进展、成果、阻塞、下一步和依据。模型声称完成或测试通过不会自动成为已验证事实。

看板可见时每 5 秒刷新，重新可见时立即刷新。心跳超过 90 秒或快照超过 5 分钟会明确标记过期；刷新失败保留最后数据并提示连接异常。桌面侧栏支持折叠，加载占位保持布局稳定，动画遵守减少动态效果偏好。

每台机器有独立的 SQLite Durable Object，当前快照与语义流分别持久化。语义变化按观察时间归入 UTC 小时桶，同小时可保留多条记录并分页读取；心跳不产生历史，迟到的旧任务报告不会覆盖当前任务。DO 保留 30 天或 10,000 条语义变化，待归档记录受保护，D1 保存归档副本。原始快照历史仍暂停写入 D1；DO 临时保留 48 小时输入，用于每机器独立生成中文小时报告，报告写入 D1 并在最近历史查询。总览直接读取 DO，不轮询 D1。详见 [AI 小时报告](docs/HOURLY-REPORTS.md)。

### 认证与隐私

网站由 Cloudflare Access 保护，Worker 校验签名、签发者、应用 audience、有效期与必要声明。本地免登录仅对明确的开发域名或 loopback 且 `LOCAL_DEV="true"` 生效；生产关闭此开关。

机器使用独立的签名 Bearer Token 向 `https://eagle-ingest.hexly.ai` 上报，避免浏览器 SSO 中断采集。该域名只提供机器上报、心跳、语义上传、自身快照、实时桥接和公开 `/api/live`，不提供看板与网站历史查询；私有 API 不开放 CORS。Token 仅在生成时可复制，保存在权限为 `0600` 的机器配置中；签名密钥留在 Worker secret，数据库和浏览器持久存储均不保存 Token。已有 `AGENT_TOKENS` 凭据可继续使用，直到轮换或停用。

侧栏显示已验证的 Access 账户与退出入口。头像服务只接收规范化邮箱的 SHA-256，查询失败时保留账户名和首字母头像。本地可配置 `LOCAL_USER_EMAIL` 预览，退出功能在本地禁用。

Codex 适配器仅提取最终回复和生命周期事件，不采集推理与工具参数；其他 harness 使用有限终端片段和管理 Agent 提供的结构化证据。文本在落盘和上传前脱敏，但启发式规则无法保证识别任意秘密；应提供简明总结与验证凭证，避免原始终端转储。

实时模式另行传输脱敏后的当前终端画面；画面与输入不写入 D1、DO 存储或浏览器持久存储。

## 使用

打开 [Eagle](https://eagle.hexly.ai)，通过 Access 登录，在 **Connect** 添加机器，将生成的接入提示词交给该机器上的 管理 Agent（推荐 Hermes，也支持其他 Agent）。

采集器需要 Node.js 24+、npm 与 Herdr 0.9.1+；实时输入当前要求 Herdr 0.9.1 的协议 22。可从 npm 独立安装，无须克隆 Eagle 仓库。网站可独立发布；当前 Agent 固定使用已发布的 v0.7.1：

```sh
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://registry.npmjs.org
eagle-agent --version
```

若 npm 下载失败，改用腾讯云镜像，二选一即可：

```sh
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://mirrors.cloud.tencent.com/npm/
```

预期版本为 `0.7.1`。命令仅为本次安装指定源，不修改全局 npm 源；镜像可能延迟同步，遇到 `404` / `ETARGET` 时稍后重试，保持固定版本。按照[安装与配置说明](agent/README.md)保存接入凭据后运行：

```sh
eagle-agent once
eagle-agent watch
# 在独立进程中运行语义 Manager，先显式配置 manager.command；推荐 Hermes，也支持其他 Agent：
eagle-agent manager-watch
# 如需网页实时查看与输入，在另一独立进程中运行，沿用安全配置且仅启动一个实例：
eagle-agent realtime-watch
```

确定性采集器默认每 30 秒运行；Manager 仅在输入变化且满足每任务限频时调用现有管理 Agent 的模型，与采集进程独立运行。安全配置中的 `watchPorts` 可指定要检查的端口，例如：

```json
{"watchPorts":[{"name":"Raven","port":7024}]}
```

机器身份、凭据、重试、后台服务与升级顺序见 [Agent 契约](docs/AGENT.md)。可将 [eagle-report Skill](skills/eagle-report/SKILL.md)交给管理 Agent；[报告 Schema](public/report-v1.schema.json)由 TypeScript 校验器生成，服务端另行检查跨对象唯一性。

## 开发

需要 Node.js 24+ 与 npm；实际采集还需要 Herdr。先安装依赖：

```sh
npm ci
```

在忽略提交的 `.dev.vars` 中配置至少 32 个随机字符的 `AGENT_SIGNING_KEY`，文件权限设为 `0600`。本地浏览设置 `LOCAL_DEV="true"`；可选 `LOCAL_USER_EMAIL` 用于头像预览。已有机器凭据可通过可选的 `AGENT_TOKENS` 保留。修改 secret 后重启 Wrangler。

```sh
npm run db:local
npm run dev:api
# 另开一个终端：
npm run dev
```

本机已配置 Caddy 时使用 [eagle.dev.hexly.ai](https://eagle.dev.hexly.ai)。Vite / Worker / inspector 分别监听 `7053` / `37053` / `38053`；浏览器测试使用 `27053`，独立 API E2E 保留 `17053`。开发、测试和生产数据分开存放。

```sh
npm run build
# 从完整源码构建独立 Agent 安装包：
npm pack ./agent --pack-destination .local
```

生产部署与真实链路核验见[部署说明](docs/DEPLOYMENT.md)。源码中的界面功能是否已上线，应以实际部署提交为准。

## 测试

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:browser
```

`npm test` 运行 Node 测试，API 用例使用独立 Miniflare / D1；Playwright 覆盖桌面与手机页面。`npm run check` 汇总 Node 测试、类型检查、静态检查和构建。

真实机器到鉴权上报、DO 和 Chromium 的端到端核验使用 `scripts/verify-live.ts`，需要可用的本地或生产 Agent 配置；生产另需有效 Access JWT。凭据准备、实际验证范围与保存在 `.local/` 的脱敏凭证见[真实链路核验](docs/DEPLOYMENT.md#verify-the-live-path)。

## 技术栈

| 技术 | 用途 |
| --- | --- |
| React、Vite、Basalt、Recharts | 私有看板、组件与可视化 |
| TypeScript、Biome | 类型检查与源码规范 |
| Cloudflare Workers、Durable Objects、D1 | 受认证 API、每机状态和语义归档 |
| Cloudflare Access、jose | 查看者身份与 JWT 校验 |
| Node.js、Herdr、Zod | 本地采集、管理 Agent 与报告校验 |
| Node test runner、Miniflare、Playwright | 单元、API 与浏览器测试 |

## 文档

- [Agent 安装说明](agent/README.md)与[配置及上报契约](docs/AGENT.md)。
- [API](docs/API.md)、[实时 Pane 语义契约](docs/PANE-SUMMARIES.md)与[eagle-report Skill](skills/eagle-report/SKILL.md)。
- [部署及真实链路核验](docs/DEPLOYMENT.md)、[实施计划](docs/PLAN.md)与[验证检查点](docs/CHECKPOINTS.md)。
- [品牌来源](assets/brand/provenance.json)、[Hexly 档案](https://hexly.ai/projects/eagle)与[服务状态](https://status.hexly.ai)。

README 使用圆角金色鹰展示图；侧栏、加载、身份入口与浏览器图标使用透明前景。根目录 `logo.png` 保留 2048px 透明主文件，应用继续使用独立的 Basalt 色板。

## 许可证

仓库未提供项目级 LICENSE；Agent 包声明为 `UNLICENSED`。
