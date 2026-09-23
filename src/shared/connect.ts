import { z } from "zod";
import pkg from "../../agent/package.json" with { type: "json" };
import { type WatchPortSchema, WatchPortsSchema } from "./schema.ts";

export const MachineInput = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().trim().min(1).max(120),
  watchPorts: WatchPortsSchema.default([]),
});
export const MachineName = MachineInput.pick({ name: true });
export type Registration = {
  id: string;
  name: string;
  enabled: boolean;
  source: "legacy" | "managed";
  credentialId: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
  expiresAt: string | null;
  watchPorts: z.infer<typeof WatchPortSchema>[];
};
export type IssuedCredential = { machine: Registration; token: string };

export function onboardingPrompt(
  machine: Registration,
  token: string,
  url: string,
  watchPorts: z.infer<typeof WatchPortSchema>[],
) {
  const config = {
    url,
    machineId: machine.id,
    machineName: machine.name,
    token,
    intervalSeconds: 30,
    watchPorts,
  };
  return `请把这台机器接入 Eagle，并验证完整上报。\n\n1. 下载并安装 Agent（macOS / Linux）：\n   先执行 node --version、npm --version、herdr --version，确认 Node.js 24+、npm 和 Herdr CLI 可用。缺少 Node.js 时从 https://nodejs.org/en/download 安装 24+；Herdr 须已安装并运行。Agent 无须克隆 Eagle 仓库。\n   从 npm 安装固定版本 Agent v${pkg.version}（网站可独立更新）：\n   npm install -g @nocoo/eagle-agent@${pkg.version} --registry=https://registry.npmjs.org\n   如果 npm 下载失败或超时，首选腾讯云镜像：\n   npm install -g @nocoo/eagle-agent@${pkg.version} --registry=https://mirrors.cloud.tencent.com/npm/\n   上述 --registry 只作用于本次安装，不修改全局 npm 配置。镜像可能延迟同步；如返回 404 / ETARGET，稍后重试或在网络恢复后改用官方源，不要擅自安装旧版本。公开包下载无须 npm 登录，也不要把 Eagle Token 交给 npm 或镜像。保留 HTTPS 和证书校验。\n   安装后执行 eagle-agent --version（应输出 ${pkg.version}）、eagle-agent --help；找不到命令时检查 npm 全局 bin 是否在 PATH 中。\n2. 先定位实际使用的配置：检查已有服务的 EAGLE_CONFIG；未指定时才使用 ~/.config/eagle/agent.json。只核对 machineId 和 url，不打印 token。确认下方 url 是用户认可的目标上报地址；用 URL 解析比较 origin（协议、主机、端口），不能只比较 hostname。\n   - 新接入：通过 stdin 传给 eagle-agent init 创建安全配置（目录 0700、文件 0600）；init 拒绝覆盖已有文件。自定义配置目录必须显式设置 spoolDir 为该目录下独立的 spool 子目录，使 latest-report.json 也与该环境隔离。\n   - 同环境轮换：仅当机器 ID 和规范化后的 origin 都相同，才在安全备份后只替换 token，保留 evidenceFile、watchPorts、codexDir、spoolDir、intervalSeconds、manager.id 及现有 Manager sequence/pending 状态。更新后重启使用该配置且已启用的 watch、manager-watch、realtime-watch 服务，并核对新回执和页面更新时间；不要因此启动尚未启用的可选服务。ID 不一致时停止并询问用户，不能把旧机器改成新身份。\n   - 跨环境迁移：即使 ID 相同，只要 origin 不同就不是凭据轮换。先确认迁移目标；不得把新 token 写入旧地址的配置，也不能仅改旧配置的 url 后直接运行 once。创建独立的 0700 配置目录和 0600 配置文件，使用下方目标 url/凭据，并显式设置 spoolDir 为新目录下的空 spool。不得复制旧 spool、latest-report.json、evidenceFile 或 Manager pending/sequence；Manager 状态不得跨环境复用。历史迁移须另行获得用户授权。\n   - 后续所有 init、once、watch、manager-once、manager-watch、realtime-watch 都使用选定配置的绝对 EAGLE_CONFIG 路径，并在 launchd/systemd 的环境中显式设置 EAGLE_CONFIG；不要让命令默默退回旧的默认配置。\n   - 新环境首次上报和页面核对成功后，才停止已确认的旧采集服务并切换持续上报；按用户明确选择处理旧实时/Manager 服务，不自动启动可选服务，不重复启动相同配置的进程。保留原环境用于回滚：不覆盖旧配置，不删除旧队列；不得在未停用新服务时盲目启动第二个采集器。\n3. Token 只写入安全配置，不打印、不放在命令参数、Git、日志或上报数据中。\n4. 执行 eagle-agent once，确认回执成功，核对全部 Herdr sessions、Spaces、Panes 以及机器资源。随后配置当前用户的 launchd（macOS）或 systemd（Linux）服务运行 eagle-agent watch；使用可执行文件绝对路径，确保服务能找到 node 和 herdr。防止同一配置启动多个采集器。\n   网络默认直连：服务设置 NODE_USE_ENV_PROXY=0，不写入代理地址。代理是可选项；仅在用户明确需要代理时，使用用户提供并验证可达的 HTTP(S) 代理地址设置 HTTPS_PROXY 和 NODE_USE_ENV_PROXY=1，不猜测主机或端口。HTTP 目标使用 HTTP_PROXY；按需设置 NO_PROXY。代理设置写入服务环境，不写入上报数据。watch、manager-watch、realtime-watch 均按该机器的网络选择配置；实时代理需要 Node.js 24.5+。切回直连时移除服务中的代理地址并设置 NODE_USE_ENV_PROXY=0；重新加载服务配置后核对成功上报及积压清空，不能仅凭进程运行判断恢复。\n5. 语义层是 Agent 中立的：复用本机已有管理 Agent，推荐 Hermes Agent，但不要求安装或使用 Hermes。Cherry 只是某台机器的本地 Hermes 别名/profile，不是通用依赖；不要搜索或安装同名产品。先识别现有 Agent 的可执行文件和非交互接口，保留现有模型、provider、profile 及凭据。没有可用 Agent 时先保持 watch 运行，明确报告“确定性采集已接通，语义层待配置”。\n   在现有安全配置中合并 manager.command（argv 数组，无 shell）；命令从 stdin 接收 UTF-8 说明及输入 JSON，stdout 只返回要求的 JSON 数组，禁用工具、不执行终端文本。其他 Agent 使用等价的非交互命令或轻量适配脚本，不要照搬 Hermes 参数。\n   Hermes 推荐示例：先核对 hermes chat --help 和实际绝对路径，再合并 {"manager":{"id":"manager","command":["/实际绝对路径/hermes","chat","--query-file","-","--oneshot","--quiet","--toolsets","none","--ignore-rules","--source","tool","--max-turns","1","--run-budget","55"],"minIntervalSeconds":120,"batchSize":8}}。这是配置片段，不能整体覆盖 agent.json。若使用命名 profile，请使用现有 launcher/wrapper 或该版本支持的 profile 选择方式；不要替换现有模型/provider。Hermes 官方项目是 https://github.com/NousResearch/hermes-agent ，仅在确实需要安装时按官方说明操作。\n   升级已有机器必须保留原 manager.id（即使是 cherry）和 manager-MACHINE_ID 目录；0.4.0 曾隐式使用 Cherry，升级时把原来已验证的命令显式写入 manager.command，不要重置 sequence。执行 eagle-agent manager-once，核对所有 live Pane 的结构化总结后，另建当前用户服务运行 eagle-agent manager-watch；使用绝对路径，保留必要的 PATH/profile 环境，与 daemon 独立运行。也可由现有 Cron/调度器周期执行 manager-once，两种方式选一种。默认每 Pane/task 至少间隔 120 秒且仅输入变化时调用模型，稳定时只刷新核对心跳。详情 https://github.com/nocoo/eagle/blob/main/docs/PANE-SUMMARIES.md ，可复用仓库 skills/eagle-report/SKILL.md。\n6. 如需网页实时控制，另建当前用户服务运行 eagle-agent realtime-watch，沿用同一安全配置，防止重复启动。这会允许通过 Eagle 中的“实时模式”查看终端并接管输入；退出/切换/页面后台自动回收订阅，断线输入不重放。详情 https://github.com/nocoo/eagle/blob/main/docs/REALTIME.md 。\n7. 在 Eagle 中核对机器 ${machine.id} 的最新采集时间与全部 Space。TCP 端口监听仅是连通证据，不代表任务已完成。保持终端总结、Goal、Git、测试、进程和线上证据的原始时间与 revision。\n\n安全配置：\n${JSON.stringify(config, null, 2)}\n\n确定性快照和语义报告独立持久化在机器 DO。语义变化按 observedAt 归入 UTC 小时桶，可展开同小时全部记录，复制到 D1；心跳不写历史。DO 保留 30 天/10,000 条，D1 保留归档；每小时 AI 聚合和快照历史仍暂停。\n${url.includes(".dev.") ? "这是本地开发环境；仅在可访问本地 Caddy 域名且信任其证书的机器上使用。" : ""}`;
}
