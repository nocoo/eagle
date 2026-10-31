# Bots — delivery plan and current state

Status snapshot. The contracts live in
[PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[PROTOCOL.md](PROTOCOL.md), [RUNTIME.md](RUNTIME.md),
[OBSERVABILITY.md](OBSERVABILITY.md), [TRIGGERS.md](TRIGGERS.md) and
[TESTING.md](TESTING.md). This file says what exists, what is next, and where it
lives. Update it whenever a stage closes.

The current tool taxonomy, native extension integration and test-evidence map are
in [Extensions and tools](EXTENSIONS-AND-TOOLS.md). The fixed upstream input includes
bounded peer exchanges and per-bot pull-request journals/tools with client presentation;
this integration preserves them alongside synchronization. Historical planned/phase-1
wording does not disable those implemented capabilities.

Fixed-content baseline integration is normally delivered as
`ee26b2bb5d0ab2530156843898e9b86c8611fb70` / tree `92d79c1e`, preserving the
sync chain and pinned upstream `182fc1f704774eb37bdbc11cde017f8ff61f1c1a`.
Authoritative `.local/sync-upstream-content/content-delivery-final.json`
SHA293f1f74 binds1018 originals; own remote/clean/ahead0/behind0 and both normal
hooks were independently accepted. Exact root267/browser191+11 existing skips/
Swift208/51/60 scopes belong to that delivery, not the next slice.

P4 CF72h explicit cache is normally delivered as `abec9dbb` / tree `8fbe3651`.
Lead/Root independently accepted own remote and clean/ahead0/behind0;
`.local/sync-p4-cf72h-cache/cache-delivery-final.json` SHA069c8aed binds1552
references, with the final itself protected by the next slice. Review P2#1's
Cache DO and Registry SQL-read classification fixes are closed. All original
failures and exact gate scopes remain unchanged.

Automatic transport on that baseline adds local publish/receive/both preferences,
direct-first receive, network-only cache fallback, stable authenticated return and
independent cache upload for already shared, ready bound replicas:
[SYNC-AUTO.md](SYNC-AUTO.md). [TESTING.md](TESTING.md) and this slice's independent
source/candidate/delivery receipts bind the actual verification and delivery state.
This slice does not claim relay/discovery/expired holder reread/peer-applied ACK,
full P4 or P5/P6. No cloud deployment or physical Mac/App evidence is claimed.

That automatic slice is normally delivered as `01d90a70` / tree `9c0949f3`;
its authoritative auto-delivery-final.json SHAaecf6d49 binds1934 references with
normal commit/hooks/push and independently verified own remote/clean0/0.
The current finite slice is [SYNC-RELAY.md](SYNC-RELAY.md): authorized online holders,
outbound relay, original-source discovery/missing-or-expired-cache reread and relay
delivery-associated actual apply receipts. Review/Lead accepted source-v26ab23ace /
candidate803c6f09 after the sole registration-ownership P2 closed. Normal delivery is
`6575f53f` / tree `ca3ea404`, single parent `01d90a70`; own remote matches and main
is clean/ahead0/behind0. Authoritative relay-delivery-final.json SHA5870b595 binds
2439 references; the next slice protects its final itself as reference2440.
Normal hooks and their exact counts/scopes are in that receipt and TESTING.
Authenticated all-path status is normally delivered as `193f75bd` / tree
`73695d14`, single parent `6575f53f`. The accepted source-v2 `863cd483` closes
status-report/status-read and its transaction-boundary P2; final25b2ea37 binds
normal hooks, exact own ref and clean/tracking0/0 at delivery. Receiver reports
and holder reads retain exact identity/binding/source keys and a separate bounded
metadata action; offline apply, retention and direct handshake signing stay intact.

The first two-physical-Mac round is independently closed at API/SDK scope:
physical finaldc9c65da binds actual6575 copies and A→B→A5/10/14/19-entry continuation,
A offline/B continuation, A catch-up and daemon restarts, with passive execution0.
It used no hand-copied history and does not certify native App behavior.
The six physical scenarios in TESTING remain final sync-PR admission requirements.
Scene5 is accepted only as the combination finalf5b7827b, whole-window6766880e
and timing38377da4: genuine product direct over Tailscale DERP, owned Miniflare
cache fallback and stable return, with exact path/counter/history evidence.
The earlier Stopped/NeedsLogin facts are historical. Neither UDP P2P nor deployed
CF is claimed, and Service does not change the user's Tailscale configuration.

The active P5 contract is [SYNC-NATIVE.md](SYNC-NATIVE.md). Source-v6 `a4e8d4b3`
and all three earlier P2 repairs are accepted; normal-v6 `3511bbd7` binds the
actual affected Node checks. Physical concurrent branchesdc891c81 and owned-alarm
scene6 `114d482d` + authority1b733989 are accepted at their actual v5 API/SDK
scope: two physical Macs and a third empty isolated C on A, original A offline,
online B relay supply, unchanged event clocks, actual R2 deletion and passive0.
This is the bounded original-alarm deadline window, not real elapsed wall72h.

A native selector/merge/composer plus same-identity App/daemon restart is now
accepted at finite `a0ca410d` + input421f922c + passive7b7f6794 scope.
The same original d693 merge is continued once with selected resources; complete
SDK history/Outbox/selection/request survive restart and execution counts do not
increase. Its actual source copy/modules/binaries are separately bound; supplement
ee54bb0b limits the earlier instance-log prefix to its actual10:21:54 content.
B's earlier bridge denial and AX trust rejection remain boundaryff597b09 history.
After the user's exact-helper permission change, one public no-prompt trust read
returns true through the same responsible host. Finite B receipt482935b0 binds
real native selection of already-ready A head2f685a07, explicit same-head resources
and one composer request r_421B189D…/submission171. Actual SDK/local skill completes,
provider3→5; same-identity App5198→6962/daemon68572→6987 restart preserves complete
export/Outbox/selection/request with no execution replay. A receives the complete
new head e8f5a483/resources with passive execution0 from an actual before captured
before B sends. All18 new execution records retain their real10exit0/8exit1;
B pre-send interruption remains cause-not-assigned; recovery is not a claimed
fix. Actual copy701/749 and native modules/binaries are separate from repository
input stability. Review formally accepted this finite B scope and final docs/tree;
P5 was normally delivered as5bfb7cc, with CI fixture follow-ups through60e4.
No duplicate merge/send or denied-operation replay is used.
Keep messages, inputs/outputs/tool results, attachments, AGENTS.md and full versioned
skill bytes with actual local execution evidence. Shared-backend reachability and
current directed grants require their own facts; the paired command bridge is not
sync authorization. P5/P6 work follows the actual first broken hop. Create the sync
PR only after all authorized goals and these scenarios pass; PR112 is now open
for review against `nocoo/eagle:main`. Do not merge it.

`182fc1f` is the historical common development baseline. The user authorized this
integration of upstream8674a3ee followed by fixed19f4a00a for PR112; do not chase a moving
upstream. Preserve all published sync commits; #109 monitoring remains closed.

## 多端 Bot 整体实施计划（2026-10-30）

当前方案：**各端独立运行，Tailscale 直连优先、Cloudflare 回退，云端增量最多缓存 3 天（72 小时）**。
架构与 Orca 机制见 [SYNC-ARCHITECTURE.md](SYNC-ARCHITECTURE.md)，源码证据见
[SYNC.md](SYNC.md)，设备行为见 [DEVICE-PAIRING.md](DEVICE-PAIRING.md)。
P0 本地闭环已推 `c073ea19`；P1 首个本地增量切片已验证并正常推送 `c8d8fd4`；
P1 恢复身份切片已正常推送 fdb8973；目录 tombstone 已验收并正常推送 60fa5e2；
P2 fixed-head696f649, ordinary-root265b0db and independent repair9475e2e were delivered normally.
Fresh first-package264cc9e/treeb40045 was delivered with own fork verified and clean/ahead0/behind0.
Receipt .local/sync-p2-fresh-resources/fresh-delivery.json SHA29bbd80f retains the initial
pre-commit formatting failure, accepted formatting delta, successful commit-attempt2 and
first fresh push with complete normal hooks. P2 local resource boundaries are verified.
P3 metadata foundation is normally delivered as460b60d/treee3a552c; HEAD/own fork were
independently verified clean/ahead0/behind0. Its authoritative delivery receipt is
.local/sync-p3-device-access/p3-delivery-final.json SHAd0eccb99; prior metadata receipts
and all original evidence remain readable. Agent1.2.0 is unpublished source, onboarding1.0.0 unchanged.
P4 first authenticated one-page pull/apply is normally delivered as4f7d035/tree959dece.
Own remote and clean/ahead0/behind0 were verified; authoritative
.local/sync-p4-authenticated-pull/p4-delivery-final.json SHA687f6650 binds194 historical
and30 delivery originals, including actual normal commit/pre-push/root/browser/Swift scopes.
Durable encrypted page objects and directed recipient envelopes are normally delivered as
8b5ca36/tree20d3fe12 after independent Review. Authoritative
.local/sync-p4-encrypted-objects/objects-delivery-final.json SHA072acfa9 binds289 historical
and40 delivery originals,including settled trace correctiona40bae3e. Own remote and
clean/ahead0/behind0 were verified. Source-v3,target-slot P2 closure,both22/23 fixture failures
and the final normal gates retain their exact recorded scope; TESTING records the delivery.
Future cache identity must preserve original source epoch/seq across repaging/forwarding;
The explicit CF72h cache slice is delivered abec9dbb. Automatic transport on
that baseline is delivered01d90a70 as SYNC-AUTO. Relay/discovery and its delivery ACK
are in the current SYNC-RELAY slice; all-path status and physical/P5/P6 remain next.
Historical candidate and per-event evidence below retains its original scope.


本轮19:45 +0800：旧019ab/720候选与证据保留；Review新增无关identity quarantine污染DELETE的P2
已取得真实HTTP红→绿，remove仅按主目标close后的实际binding清理同身份alias。新affected173/173、
types/lint、Bots普通/coverage各722/722及crash9/9均exit0；不重复未改的eval/perf，其旧范围单列。
该19:45候选随后已Review/Lead接受；60fa5e2正常commit/push exit0，root260、browser191/11既有条件排除、
Swift287全绿并核远端clean。19:59起P2先补契约/真实双daemon红，不称完整P1/P2完成。

P2 20:10过程记录：首HTTP红→绿1/1，版本交错/安全边界局部绿；安装I/O误留pending与
启动owner泄漏已取真实red并窄修。affected首轮42/44、type绿、lint格式红、资源定向crash3/3；
正在收并行安装与显式本机资源路径断言，不沿旧gate宣称本片最终绿。详见根CHECKPOINTS和.local/sync-p2-resources。

P2 20:22候选：标准fs mkdir/rename竞争校验、独立run输入版本oracle和完整system本机路径映射
已收口；affected46/46及分支fixture定点9/9，最终types/lint、Bots普通/coverage各734/734同套、
crash10/10、三个对应eval各1例、perf1/1均exit0。首轮check733/734的并发provider序号假设红保留，
fixture改按实际user输入回答，原分支断言不变。正冻结候选交独立Review；未commit/push，
普通root聊天排队/编辑版本选择仍planned，不称完整P2或云/物理设备完成。

P2 20:38 Review窄修：旧766f101与734/10证据保留；同ID已接纳重试的真实红已最小修为公开Tx
核实际SDK submission，affected60/60、定向crash4/4绿。warm HTTP task retry资源预检无failure origin
亦已实跑红，最小runtime.task.retry.fail边界及日志契约27/27绿；types/check-only lint通过。
新生产字节的正常check/crash/三个对应eval待收，不借旧gate称最终绿；未commit/push，下一root片不写。

P2 20:40最终窄修候选：同ID实际SDK接纳查询与warm retry资源预检唯一origin两项均真实红→绿。
review-fixes-affected87/87、types/check-only lint、Bots普通/coverage各763/763同套、crash11/11、
三个精确对应eval各1例均exit0，coverage95.89/89.27/91.57。最终source/test冻结，正绑定新tree与
原log/exit交增量Review；旧766f/734/10及perf保留原scope，不虚称新跑。当前未commit/push，
首片仍in progress；普通root后片、cloud/网络/物理设备未交付。

### 开发基线与 PR 边界

在自己的 fork [MashellHan/eagle](https://github.com/MashellHan/eagle) 开发。历史开发基线已合入
`nocoo/main@d69359b` 与 [#109](https://github.com/nocoo/eagle/pull/109) 的 `165d154`，
原 `bot-sync/base@165d154` 和全部已发布同步提交保留。#109 已于2026-10-30 19:58:52Z
正常合并；其上游 merge commit `5d48ba0a` 的 parents 为 `d69359b`、`165d154`，
tree 与 `165d154` 完全相同。在已交付干净节点 `8b5ca36` 后，实际 fetch 确认该最新
`upstream/main`；merge-base 为 `165d154`，两者内容差异为空。
本次基线整合的固定父系为同步父 `8b5ca36`、上游父 `5d48ba0a`，共同祖先为
`165d154`；保留全部同步源码和已发布提交。实际正常提交与远端结果记录在
`.local/sync-upstream-109` 的最终交付收据，准备或候选记录不代表远端交付。
本地开发目录为 `/Users/mengxionghan/workspace/eagle-sync`，按仓库规则在本地 `main` 集成。

复用 #109 的设备群/配对、helper 文件身份、后台服务、独立设备 Worker 和
`SharedDevicePort`，以 [DEVICES.md](../DEVICES.md) 为契约。该 port 提供设备执行；
同步身份、握手及密钥元数据通过独立版本化的 Bots `DeviceSyncPort` 接入。
不重新实现设备底座，也不把现有注册 signer 当作通用签名接口。

历史同步候选基于 `182fc1f704774eb37bdbc11cde017f8ff61f1c1a`；当前 PR112
按授权先整合8674a3ee、再整合实际 main 的固定19f4a00a，复核祖先与同步 diff，不重复带入 #109。
个人验证 PR 的 `bot-sync/base` 已从历史165d154正常快进至182；upstream PR 目标为 `main`。

### 已确定的行为

- 同一个 Bot 在 A、B 各有本地副本和运行时，可以同时执行；A 离线或云端不可达时，
  已就绪的 B 仍使用本机已有上下文运行。
- 共享一段对话，顺序接续已同步历史，并发保留分支。默认沿当前分支继续；
  显式合并创建新上下文节点，保留双方原始记录。
- Bot 定义、消息、工具结果、附件、压缩来源、Bot 专属 `AGENTS.md` 和完整技能包跨端
  共享。每轮固定实际使用的资源版本；工作区、模型凭据和系统权限由执行设备提供。
- 本机先保存并执行，再异步同步。历史导入不触发模型或工具，不复制另一设备的任务队列。
- Tailscale 可达且通过应用身份验证时优先直连；失败自动回退 Cloudflare，恢复后稳定切回。
  新增增量仍独立后台上传 3 天缓存，直连接收确认与云端缓存确认分别记录。
- 安装后本机环境就绪；App 配对后对新增可管理在线设备请求 Always ask，用户仍可选择
  All approve/Always ask/暂停。多 Bot 共用设备及按目标设备串行的要求继续有效。

### 组件与数据归属

| 组件 | 职责 |
| --- | --- |
| 本机副本库、运行库和资源目录 | 保存原始历史、分支、outbox、同步位置；独立执行并恢复本端 run |
| 本机连接管理器与同步入口 | 群内发布 Tailscale 端点、验证对端身份、选择直连/中继并恢复订阅；共用事件与游标 |
| 独立 Bots Sync Worker | 认证入口、出站 WSS 中转、缓存传输及在线副本补读 |
| 现有 DeviceRegistry / 新增目录 Sync DO | 分别管理设备群与成员权限，以及共享 Bot 目录、副本位置和删除事实 |
| 每 Bot 一个 Sync DO | 路由、去重与回执元数据、同步位置和限时对象引用；不存消息正文 |
| R2 | 加密增量及临时大对象，最多 72 小时；不作长期历史库或完整基线仓库 |

参考 Eagle 现有 LiveRelay 的鉴权、出站连接与转发机制，保持 Bots 独立构建和部署；
不直接导入网站 Worker/Agent 源码，现有机器采集和日报保留规则由其原契约管理。
Orca 固定基线为 `6b937c7e5f5a`；借鉴持久日志、游标补读、幂等回执、连接恢复和
完整技能包。多端本地执行、分支合并与 3 天缓存由 Eagle 新增。

Tailscale 直连进入本版范围；专用同步入口仅向 Tailscale 网络开放。未安装、未登录或
不可达时直接使用云通道，不把 Tailscale 作为安装前置条件。建议直连等待 2.5 秒后
启动中继竞争，中继期间每 15 秒探测并在稳定后切回；参数以实际验证调整。

### 3 天缓存契约

- 时间从**服务端首次缓存成功**算起，`expiresAt = firstCachedAt + 72h`，不是三个自然日。
  读取、重试、重新分批或设备离线均不得刷新原事件/对象的到期时间。
- input、output、工具记录和临时附件均遵守此上限；到期停止补发并删除对象。
  正文不写入 DO SQLite、日志或追踪，不另存长期摘要/完整聊天基线。
- 对象保存和校验成功后才发布带到期时间的引用；DO/R2 不假设联合事务。
  区分本机已保存、云端已缓存及对端已应用；缓存 ACK 不能充当备份或执行完成证明。
- 本机保留原始历史。缓存过期后，从任一持有数据的在线副本补齐，不绑定创建设备，
  不靠反复上传旧历史延长云端保留期。
- 新设备从在线副本取得基线与资源，再补增量。没有持有者在线时等待缺失数据；
  已有可运行副本可以继续，待补齐的数据不会被静默省略。

| 场景 | 必须达到的行为 |
| --- | --- |
| Tailscale 可达 / 不可达 / 使用中断开 | 认证后优先直连；失败回退、恢复后稳定切回，不重复消息或执行 |
| 已具备基线，A/B 在缓存有效期内错峰上线 | B 取得缓存覆盖的增量，持久应用后继续 |
| 缓存满 72 小时，A 或其他持有者在线 | 从在线副本补读，完整保留历史和分支 |
| 缓存过期且没有持有者在线 | 标记缺口；B 仍可基于本机已有完整上下文新开 run |
| 双端并发、重启或反复重传 | 不丢分支、不重复执行、不延长缓存保留期 |

### 交付顺序与完成条件

| 阶段 | 状态 | 交付内容 | 退出证据 |
| --- | --- | --- | --- |
| P0 — 契约与上下文验证 | local verified | 身份、因果关系、被动导入、资源版本、端点/握手、双路径游标与确认语义 | 两个独立 SQLite 重建等价上下文；导入零执行；接纳与导出之间的崩溃可恢复 |
| P1 — 本地副本与分支 | in progress | 持久来源日志、outbox、ID 映射、缺口补读与本端恢复 | A 停止后 B 可运行；重复/乱序同步保留两支；不恢复其他端任务 |
| P2 - resources | local verified | fixed-head696f649, ordinary-root265b0db/repair9475e2e and fresh264cc9e delivered normally | Complete local version loading; raw contents/tool associations retained |
| P3 — 设备底座接入 | first metadata slice delivered460b60d | 复用 #109 的安装/配对/helper/权限；新增同步身份授权、Tailscale 端点发布和共享访问接口 | 现有设备能力保持有效；无 Tailscale 可走云通道；端点身份、群成员和同步权限真实生效 |
| P4 — 直连、中转与 3 天缓存 | delivered through193f75bd: automatic direct/cache return, online-holder relay/discovery and all-path persistent status | 认证直连与连接切换、独立 Worker/DO/R2、端到端加密、密钥撤销、72 小时缓存与补读 | 本地双端和 Miniflare 验证直连失败回退、恢复切回、旧连接迟到、双路重复、ACK/到期/实际删除；读取与重传不续期 |
| P5 — 原生多端流程 | source-v6/normal, finite A/B native/restart and final binding accepted; B pre-send cause-not-assigned | 有界目录、持久 context、两父合并/资源选择、同一原 composer/Outbox 与 owned composition | A/B 真实控件各一次接续、本机 SDK/skill、同身份 App/daemon 重启、完整历史/资源及零重放 |
| P6 — 多机验证与交付 | six scenarios have separately scoped physical evidence; final Review/delivery/PR pending | 两台物理 Mac、按需隔离 C，API/SDK 并发、Tail DERP 上的 direct/cache 切换、owned alarm 到期补读 | 各收据保留其实际层级；不扩称 native 并发、真实墙钟72h、UDP P2P、发行信任或部署 CF |

依赖：已集成 #109 基线 → P0 → P1/P2/P3 → P4 → P5 → P6。P3 尽早做物理双 Mac 验证；
P6 验证最终候选，C/D 隔离实例证据与真实机器分开记录。
原范围映射：D0/S0 → P0；D1–D4 → P3；D5 → P3/P6；S1–S2 → P1/P5；
S3 → P2；S4 → P4/P5/P6。

### 首个切片与验证要求

P0 正常 push 与门禁证据在 `.local/sync-p0/push-c073ea1/`。P1 当前已接通独立
replica.sqlite、committed entry补扫描、固定ID本地intent/outbox与鉴权pull/apply/status。
局部真实SQLite、分页、被动转发、分支和SIGKILL已绿，累计历史可超过单页8MiB；
2026-10-30 17:43 +0800 的本地候选正常Bots check普通/coverage各673/673（同套不累加）、
types/lint、crash8/8、完整本地eval11/11、perf1/1均exit0。Review随后确认三项P2兼容缺陷：
旧P0 receipt直接run、独立完整branch carrier、root后来busy阻断固定head的独立分支。
真实9失败后窄修，18:03 +0800 新affected49/49、check普通/coverage各682/682、types/lint、
crash8/8、对应P0/P1 eval各1/1、perf1/1均exit0。上述18:03候选随后完成最终Review，
三项P2关闭；c8d8fd4/tree9cbac731已正常commit/pre-commit及push/pre-push exit0，远端已核对。
首片已交付，不称完整P1完成。自动head采用bounded fork与紧凑receipt，连续外来head复用完整prefix；
原compaction 5+5保持不变，旧正文/工具结果/资源写入次数未随三个增量增长。
epoch轮换、目录tombstone、P2资源
安装及后续云/设备/UI条件仍planned。本轮不重复网站、Swift或物理Mac的旧证据。

当前恢复身份片只在fresh本地运行库组合bind/import/apply/run，保留sharedBotId并生成
新replicaId/epoch；新增鉴权receipts摘要枚举覆盖无source_events的旧完整P0载体。
证据位于.local/sync-p1-recovery；原fixture目录前置不足的红/空页日志保留并注明，
正确directory.botDir种库、独立head真实export预检后在c8d生产快照重取路由红。
局部恢复/枚举/Session guard六项绿，最终affected42/42、types/lint exit0；最终Bots check普通/
coverage各688/688（同套不累加），crash8/8、对应eval各1/1、perf1/1全exit0。
旧22路径候选tree4de501/receipt68475d已冻结保留。Review确认receipt枚举raw I/O未进入
Session保护的P2，当前以公开close封闭实例做窄修：原I/O不变、后续/在途结果拒绝，
不伪称SDK SessionEnd.failed；空/compact、取消/StorageRequestError、唯一日志身份与cleanup
均补回归。旧688仅属旧候选；新receipt-review-affected51/51、types/lint、
check普通/coverage各697/697、crash8/8、两对应eval各1/1、perf1/1均exit0。
新receipt-io-candidate收据绑定相对4de501的tree/路径SHA和新日志，待增量Review；
本片未提交/未push，正常hooks尚待验收后执行。大于8MiB用原分页，不放宽请求cap，
不复制活动库；备份前未上传branch与独立P0 branch、原始system/provider顺序直接断言。

eb874d最终Review仅余close队列交错P2：同轮排队receipts/close的真实red为14项12过2败，
cleanup另铸第二error。现以独立Session-close通知状态在末次scan执行时判断；健康close仍
把尚未进入后台扫描的committed原entry/body准确持久化一次。source/test已冻结并单独交窄审。
19:03 +0800 新affected54/54、types/lint、Bots check普通/coverage各700/700（同套不累加）、
crash8/8、两对应eval各1/1、perf1/1全exit0。receipt-close-queue-candidate记录相对eb874d
的路径/tree/日志hash；旧eb874d/receipt-io-candidate及697 gate全部保留。仍未commit/push，
等待此唯一P2增量Review及Lead验收；不编码下一tombstone切片或新增原生/网络验收。

先完成 P0（以下为当时验证合同，交付状态以上方明确结论为准）：在隔离目录创建两个真实 SQLite，用受控 provider 生成包含工具结果、
指令变化与压缩记录的历史，验证 B 被动导入、A 停止后 B 发起新 run、重启恢复及
并发分支。仅允许明确的本地 ID、工作区路径和 provider 会话身份映射；
不能用复制活动 SQLite、最近消息窗口或删除不支持内容来替代上下文保真。

行为实现遵守严格 TDD，相关契约与 fixtures 同步更新，v1 保持 additive-only。
Bots daemon、Bots Swift、同步服务分别运行正常门禁；最终交付还执行根
`npm run check`、`npm run test:browser` 和 macOS 检查，不降低既有要求。
缓存验收覆盖 72 小时到期前后、上传成功但引用发布失败、清理失败重试及有/无在线
来源的补读；拒绝读取和实际对象删除分别取证。
传输验收覆盖没有 Tailscale、端点不可达、握手失败、直连中断、稳定切回、旧回调和
双路重复；直连不得绕过成员撤销，收到历史不得重跑工具，直连成功不能假报云缓存完成。

分别测量本地接纳、模型首字、另一端可见和首次副本就绪的 p50/p95，保留
[既有性能界限](TESTING.md#performance-measurement)，区分 Tailscale、云中继及切换耗时。
记录实际 Tailscale 网络路径，不把 DERP 转发当作物理直达证明。DO 使用可休眠连接；
临时对象批量写入，容量按滚动 72 小时新增量估算。Workers Paid $5/月起，
R2 按用量计费且有独立免费额度，均共享账号额度；详见 [费率依据](SYNC.md#容量与费用基线)。

2026-10-30 16:38 +08：P0 本地候选已接通受认证 daemon/Registry/SDK 入口。
真实入口红测是 A 已完成工具写入后 export 返回 404（`.local/sync-p0/http-red.log`）；
资源续跑、nested 兼容性及手动 run 边界均保留独立真实红绿。两份 SQLite、220+ 原记录、
真实工具文件字节/结果、指令与有序工具声明、SDK 压缩、edits/head 映射、重启、A 关闭后
B 续跑、A/B 同 head 独立执行与分支交换、第三库重新导入及四个实际 commit/SIGKILL
窗口已覆盖。nested 历史明确拒绝完整导出；保存但未安装的指令/skill bytes 阻止续跑。
P1 outbox/副本日志与 P2 AGENTS/skill 加载仍 planned。

首轮 Bots check 642/642；最终收口后保留一次 coverage 与一次普通轮的既有 50ms
shell 首输出时序失败，以及一次新增测试格式失败。独立 fixture 修复 `e690a83` 后的
`bots-check-timeout-formatted.log` exit 0：常规与 coverage 各 649/649（不累加）、
types/lint 通过；最终 P0 源码 crash 6/6、local-run eval 1/1。Bots Swift 首轮
40+44+52=136 通过，之后 Swift 输入未变且未重复运行。当前尚待独立 Review 和正常
pre-push；未 push。没有云端、Tailscale、物理双 Mac 或 App/UI 验证。

2026-10-30 16:50 +08 follow-up：Review 的 sections 顺序/hash P1 与二次来源扫描 P2 已修。
真实 receipt/B/C prompt 反转与不同顺序同 head 红测7失败，修后 runtime/API21通过；
摘要改为验证后的 v1 envelope JSON.stringify，已知字段按schema、原model/data对象保留
插入顺序；来源循环前仅建一次反向Map，branch→C断言原entry/task归属。保留两轮新测试
readonly类型失败与一轮真实shell附加诊断红；独立test-only `d8f3bfe` 用exec sleep并保留
全串断言。最终 `section-order-bots-check-exec.log` exit0、常规/coverage同套各657，
types/lint通过；crash6、local-run eval1通过。Swift输入未变不重跑；独立Review与正常
pre-push尚待完成、未push；P1–P6及云/物理Mac边界不变。

通用 LAN 自动发现、Web/手机客户端、云托管运行、整工作区同步及未完成 run 的跨端接管
留待后续；部署、发布及 App 替换按项目规则另行执行。

## 共享设备与配对重构（2026-10-29）

用户最新要求替代旧 M0–M1 的“手填部署信息、每 Bot 机器授权”产品流程：
安装并首次启动 Eagle 后本机环境自动就绪；固定上游82d6f0d的 App 配对流程对新加入、
在线且支持 policy.manage 的机器请求 Always ask，失败时保留该机器实际报告的状态，
不批量改写既有持久 policy。设备由整个 App 共享，
通过默认 1 小时、最长 24 小时的单次配对码加入设备群。配对成功后的设备身份持续
有效，直到撤销。App 内 menu 弹窗（含“会话状态、基础控件”等入口）必须能打开
真实设置，不能只有系统状态栏/菜单栏入口；设置统一提供“设备”、配对和设备级
权限，Bot 详情展示可用电脑与 agent 实际执行目标。一个群支持 A/B/C/D 等三台以上
设备；配对自动把未入群设备纳入已有群，不受输入配对码的方向影响。agent 按任务
和设备信息自主选择目标。配对用 HTTPS，单个 Registry DO 原子保存配对/群成员；
执行复用出站 Agent 长连接和调用端单次 WSS，多个 Bot 共享目录、身份与访问服务，
首版按目标设备串行，不做并发调度或连接池。详细行为、
Orca 固定源码参考、认证/存储边界及旧代码处理见
[共享设备与配对方案](DEVICE-PAIRING.md)。

本轮只聚焦安装即执行、跨 Mac 自动注册/配对/设备群与明确目标执行。共享设备目录
由内部自动接线提供，不新增 Bot 分享链接、Bot 互联/共享开关或额外配置流程。

配对后端选为个人账户的长期独立服务 `https://eagle-devices.mxhan.workers.dev`，
复用现有 Registry/relay，只带两个 SQLite DO 和新服务的 v1 migration，不改既有
个人或上游网站/ingest。c0b4942 的完整 root check/browser 已通过；独立入口 5 项
红绿及增量审查完成，28f4aef 的最终 check 235/235、types/lint/build、绝对路径 dry-run
通过。Root 已部署该 SHA，公网 health exact revision 与匿名目录 401 已验证。
之后的配对包和独立 UI 更新包都须显式使用此 HTTPS build origin，保持相同 candidate
profile/data。本机真实执行已验；真实 App 公网注册/WSS 和物理 A/B 配对仍待验。
本轮合入已批准的 settings-layout `1d1fd31` 与设备页 polish：添加设备整行展开，
多个视图共用一次周期观察，无变化不发布、不闪禁用，旧读取不能覆盖较新操作。
局部 Swift 红绿及增量 review 已完成；最终门禁和唯一 push 由 Root 执行。
当前安装仍由原 UI/思考等级入口持有；后续完整 HTTPS 包须保留它已授权的 thinking
改动，待完整来源/安装权交接，或由原拥有者统一组装，不能以纯设备包覆盖。

2026-10-29：已从 `nocoo/eagle@7101566` 启动实施。Eagle Herdr 团队使用独立
worktree；旧 `main@c34be59` 只作按需复用来源。当前尚未完成设备群或配对验收。

| 阶段 | 状态 | 范围和退出证据 |
| --- | --- | --- |
| D0 — 产品与契约 | in progress | 多成员群、方向无关的新增设备、单 Registry 配对事务、agent 选机和按设备串行已定；所属契约及审批位置随实现固定 |
| D1 — 本机安装即用 | in progress | 当前 Mac 常规安装、文件身份、真实 Bot 写读及同包重开已通过；干净 Mac 和分发签名尚未验证，不要求用户 Node/部署表单 |
| D2 — 配对与群认证 | in progress | Registry/relay 本地协议与独立入口已验，28f4aef 已部署个人产品服务；真实 App 公网注册和物理 A/B 配对待验，A/C 群加入 B/D、回包丢失及跨群拒绝的本地证据不替代实机 |
| D3 — 设备设置与 agent 联动 | planned | App 内 menu → 真实设置 → 设备；配对/状态/移除；共享设备 port 与系统引导、agent 明确目标调用；既有/新 Bot 顺序操作群内设备，目标证据可核对，旧逐 Bot 授权随替换删除 |
| D4 — 设备权限与恢复 | planned | All approve / Always ask / 暂停，设备端真实执行策略、审批绑定与过期、journal 去重及原 ID 恢复；不存在只改 UI 的权限模式 |
| D5 — 安装与多设备交付 | planned | 完整门禁、签名安装包、真实 Mac A/B 联动与退出 UI 验收、补充 C/D 验证四成员群；真实硬件与隔离实例分别报告，部署/发布按具体操作授权执行 |

首个贯通切片覆盖安装即用、配对后新机器的 Always ask 请求、A/B 双向执行和多 Bot 共享，
尽早实测两台 Mac；并发执行、多路复用和复杂调度不作为本轮前置工作。
执行 policy 不替代同步授权；跨设备同步仍独立核当前 B→A grant。

工作分成 App/集成与设备服务两条不重叠的实现线。迭代遵守行为 TDD 并只跑受影响
检查；完整候选统一执行仓库门禁，不建立额外验收脚本、重复评审或流程任务。
每个小功能切片通过受影响检查即提交，交同一位只读 reviewer 按明确 base/head
增量审查；App 与服务分支均如此，阻断项由写入者修复提交并闭环。
本轮 Lead/reviewer 使用 Astra Max，服务开发按用户会话偏好使用 Sol xhigh。
部署、发布和日常 App 替换在本地候选完成后按具体授权处理。

检查边界：根 `npm run check` 和 Linux CI 仅安装根 lock，不加载 Bots 源码/依赖。
独立 Bots 继续运行自己的 `npm run check`。App/设备联动使用显式 `npm run test:devices`
（`tests/device-integration/`），需要两边各自 `npm ci` 后经真实进程/port 验证；macOS
CI 同样显式准备两边和 Agent 构建，再执行此检查及原 Swift 门禁。不跳过依赖缺失，
不把 Bots 并入 root workspace，也不让跨产品回归隐式进入根 `tests/*.test.ts`。

已落地的首个 App 切片：menu 的模板导航增加“设置…”，宿主注入当前 workspace
真实设置动作；重复打开不关闭设置。`GallerySettingsTests` 先实测旧视图缺少入口，
再通过 AppKit accessibility 点击新按钮并核对宿主回调一次；尚未替代打包 App 的
设备页点击验收。证据在本地 `.local/device-evidence/menu-{red,green}.log`。

设置入口及窗口重开路由经 `b399936` 修复和只读 review 已关闭。Bots 共享 v1 socket
与工具切片已接入 daemon 配置：新旧 Bot 自动获得目录/明确目标的执行和查询取消，
durable memo 在发送前固定 ID/目标/参数，native 工具经同设备接纳与完成接缝。
局部 30 项测试、类型和 Biome 检查通过；真实 Unix socket 测试与真实文件 native
策略测试均已执行，但整 App/helper 启动及 native 租约跨实际 daemon 的贯通仍待下片。
本次有效行为红测是已有 Registry 不给注入 port 的 Bot 提供 `remote_status`；最初
socket 新模块缺失只算构建缺口，不作为行为红测。证据 `shared-bots-red.log`、
`shared-tools-green.log` 位于 `.local/device-evidence/`。

身份核心已实现 Ed25519 Keychain 持久化、精确七行注册验签输入和完整 typed approval
校验；Swift/Bots 共用独立 canonical fixture。先复现缺失参数仍被签名，再通过
7 项 Swift 身份测试（含真实隔离 Keychain 写入/读取/清理）及 9 项 Bots 适配器测试。
这片未接 helper 代码身份验证、SMAppService 或人工确认 UI，尚不能签发实际用户审批。

Swift 私有进程宿主已用实际 Node 服务验证：自动 configure、本地离线就绪、中文
文件写入、Bot 管理拒绝与 parent 管理策略生效。完整 typed approval 由宿主确认
回调后签名；未连接/拒绝不签。3 项宿主测试包括真实内核 boot UUID 读取，审批
回调未接线的行为红测已保留。代码身份 XPC、后台注册和人工确认页面仍在接线。

XPC 与独立 EagleDeviceHelper 可执行目标已加入：XPC 在每条消息上执行双向代码
签名 requirement，管理方还需同 UID；发行 helper 校验 App 与自身签名团队一致。
真实错误代码身份的管理写入先红后拒绝，4 项 pipe/XPC 测试通过。SMAppService
注册适配器已写，尚待完整候选包启动；本地 ad-hoc 签名不作为发行身份验证证据。

宿主 origin 大小写/默认端口与 Node 对齐，并接受发行 Mach service 名称；并发 retry
合并且等待旧 Node 实际退出才允许替换。真实延迟退出进程先复现多个新子进程及
初始化失败，修复后 6 项宿主测试通过；设备页 model 已独立集成，尚在增量审查。

App 监督器已从 bundle 解析 Node/Bots 并固定注入 v1 设备 socket；本机未就绪或停用
也不删除接线。接管既有 daemon 前核对 health 的设备配置摘要。候选使用独立数据、
端口、provider 配置与 outbox，真实 Node/Bots 子进程经 Swift 监督器启动的 5 项局部
测试通过（测试用 runtime 链接，不是发行装配）；主窗口和实际候选包仍待贯通。

窗口连接跟随共享 daemon 的实际 running 状态；打开第二个窗口或在设置重试成功后，
无需重开窗口即可加载 Bots。同一窗口合并并发连接，关闭时取消连接并使旧代次失效，
迟到的工厂/目录结果不能复活已关闭窗口或覆盖新连接。局部模型回归先复现重复连接、
关闭后复活和旧连接覆盖，再验证修复；此证据不替代实际多窗口点击验收。

本阶段交用户试用的功能构建为 `259614a`，独立候选在
`apps/macos/.build/device-candidate/Eagle Device Candidate.app`。真实首次启动、本机
离线执行、本地 API 自动认证和退出 App 后 helper 持续执行已有证据，必要门禁通过。
最终 ad-hoc 包更新后遇到旧 SMAppService 启动约束，需通过现有设备开关完成关闭后
重新开启来刷新注册；此恢复尚待用户操作，不能把此前 online 证据当作当前就绪。
隔离本地 API 与 Raven 偏好保留；本阶段停在用户试用，下一功能只在收到反馈后推进。
物理多 Mac、真实 UI 点击及发行签名/公证仍为未完成边界。

首次用户试用发现 helper 更新后 macOS 保留旧启动约束：App/XPC 超时、Bot socket
ECONNREFUSED，未发生本地 Registry 配对。当前修复在包指纹变化（或旧安装无指纹）时
由真实 App 串行注销/重新注册；同一包重开不停止 helper，系统审批仍须满足。状态读取
期间保留停用入口；仅确有原配对请求时显示配对恢复提示，不修改任何原 ID 或历史。
后台注册、延迟注销、失败回滚以及 UI 超时文案已有局部行为红绿，真实候选恢复待重签启动。

14:40 当前收尾：注册审批 P2 已关闭；真实 GUI 已确认聊天、两个窗口与关窗重开后的
两个 Bot/历史保留。LWCR 刷新后暴露 login Keychain 读取阻塞，用户明确选择私有文件
凭据；FileVault 以 0700/0600 和无扩展 ACL 为边界，16 项局部测试通过，ACL review
已关闭。旧 Keychain 与 journal 原位保留，固定 socket 不变；原 journal 的 source/target
scope 隔离新身份、原 ID 不挪目标、native 阻断仍覆盖旧行，真实进程/运行时 27 项通过。
当前设备保持停用，正从新目录完整装配并签名独立候选；下一证据仅为 Root GUI 启用后
的本机真实执行。物理多 Mac 与发行验证仍待后续授权和实际环境，不作为当前本机交付前置。

本机交付改用 `~/Applications/Eagle Device Candidate.app`，保留 `.build` 装配产物。
整包原字节复制、没有重新签名；实际 GUI 启用后 helper running、文件身份自动创建、
本机可用且连接隔离本地 API。真实 Bot 已完成 `remote_status → bash 写文件 → read`
读回，Root 独立核对磁盘内容、两个 Bot 与私有配置保留。同包关闭/重开已通过：
App/Bots 实际退出，helper PID 不变，身份摘要/0700/0600 保留、历史恢复、本机可用，
没有 Keychain 提示。当前“云端已连接”仅指本机 127.0.0.1:17053；公网和第二台 Mac 未验。
candidate 构建期 HTTPS service origin 小片已实现并增量审查通过，相关装配检查 15/15；
显式非空值校验并规范化，未传或空值仍使用本地 origin。候选身份和数据继续隔离，
不加用户配置表单、Bot 分享链接、Bot 互联或共享开关，不引入新的迁移框架。
当时交付的 c0b4942 产物使用默认本地 origin。后续用户已选择独立
`eagle-devices.mxhan.workers.dev` 产品服务；新配对包及之后的 UI 包改用该 HTTPS
构建输入。28f4aef 服务现已部署并通过公网 health/匿名鉴权检查；真实 App 注册/WSS
和物理双 Mac 验收仍待执行。

## Where the code lives

### Helper startup recovery (2026-10-30)

Installing `20b13f0` reproduced a signed helper launch-constraint rejection after
the automatic unregister/register had already run. The installed App recovered
through its device switch and a targeted LaunchServices refresh; its private
device adapter executed a read-only command, with local readiness and the public
cloud connection verified. Identity, Raven configuration and histories remained.

The follow-up moves registration/signature work off the UI actor, adds an
authenticated helper handshake and one bounded registration recovery, starts from
App launch as well as the shared view lifecycle, and observes cold local readiness
promptly before waiting for cloud directory data. Regression tests reproduced
unreachable-but-registered startup, delayed readiness and missing retry controls;
the handshake has a real XPC regression with Node not started. Candidate assembly
also gives both the bundle and LaunchAgent configuration the same distinct build
identity. Earlier registration-only approaches failed real upgrades; the final
`fef7203` candidate passed two consecutive complete signed upgrades without manual
retry, reaching local readiness in 12.83/11.39 seconds and cloud online in
13.53/12.17 seconds. Both jobs ran once and had never exited when checked.

The `4cbeb98` SDK-compatibility follow-up exposed an additional upgrade boundary:
those two successful packages had identical helper bytes, while the relinked
helper again failed launch constraints after replacement. The candidate installer
now prepares unregistration before moving the old App, using a maintenance entry
that runs before SwiftUI or Bots initialization. It checks the old job and PID
independently and preserves the old bundle on preparation failure. A legacy
candidate may use the new signed maintenance process once, subject to the same
postconditions. The fixed identifier and versioned executable path alone still
failed live upgrades, as retained in the retrospective.

The candidate now versions its service Label, MachService and plist filename by
the same build, while retaining its profile, socket and data paths. At `2bea0d6`,
a complete debug-to-release upgrade changed the helper SHA/CDHash, automatically
removed the old service, reached local readiness in 10.60 seconds and cloud online
in 11.77 seconds. The new job ran once and had never exited; the old job was gone.
The first adoption of versioned names used the installed App's maintenance entry
to clear the already-failed legacy job and is not counted as automatic upgrade
acceptance. Identity, Raven, token and catalogue hashes matched, both history files
remained, and installed local execution plus physical MacMini-2 to MacMini 1
execution/query by original operation ID passed again. CI SDK compatibility still
required a new GitHub run; both Check jobs subsequently passed at `cb55083`,
including the older SDK, native focus, formatting and coverage gates.

The scope cleanup at `d121736` removes duplicate website device bindings, the
external registrar subprocess, the helper filename suffix and a redundant build
environment marker. The standalone service, versioned service names and strict
signing checks remain. Both complete simplified upgrades passed without manual
recovery: local/cloud readiness took 11.55/12.51 seconds, then 12.70/13.48 seconds.
The second changed the helper SHA/CDHash at the same executable path. Installed
local and physical MacMini-2 to MacMini 1 commands, including an original-ID result
query, passed. Identity, Raven, token and catalogue hashes matched; both recorded
history files exist, without a fresh byte-for-byte history comparison. Cleanup
push gates and its own GitHub run remain pending.

The installed App's menu opens the actual resizable Settings window. Pairing is
above My Devices and always visible; resizing survives closing/reopening, and an
input draft survived twelve seconds of status refresh. Each row keeps its policy
and Remove controls visible, with inline Details expanding/collapsing correctly.
With only Settings open, one approval window appeared, closing it denied the exact
request, and allowing a second read-only command completed successfully. The local
policy was restored to All approve. Identity, Raven configuration, daemon token,
catalogue and both histories were preserved.

The installed Bots adapter executed a hostname command from physical MacMini-2 on
physical MacMini 1 and queried the identical result by its original operation ID.
The second Mac still runs an older Agent without remote policy-management capability;
changing that physical peer's policy requires updating it. Reverse-direction and
fresh-machine installation acceptance remain distinct from the verified A-to-B
operation. No npm publication or distribution-signing/notarization is claimed.

### Exclusive search providers (2026-10-28)

Services now has one compact Search section: a single provider selector above
independent DeepSeek and Tavily key rows. Saving a key preserves selection; choosing
a provider deselects the other without deleting its key. A provider without a key
cannot be selected. Persistence serializes changes and publishes only after a
successful write. Neither an ambiguous file nor an upstream failure chooses a
provider by catalogue order.

Bot tools stay `web_search(query, count?, needContent?)` and `web_fetch(url)`.
A stable routing client resolves provider credentials at each invocation, so a warm
Bot follows saved changes without a new Harness; in-flight calls retain their client.
Tavily uses native Search/Extract through platform fetch, with no additional package.
Provider wire normalization stays below the tool interface and usage remains `search`.

The daemon gate passes 509 tests with 95.51% lines, 88.20% branches and 91.42%
functions. Both provider adapters and their shared HTTP client have 100% line/function
coverage. The hosted app passes 177 tests with 95.9% configured logic-line coverage.
Tests cover explicit selection, separate keys, persistence failure/retry, warm routing,
in-flight changes, schema equality, cancellation and refusal without fallback. Earlier
red runs also hit the existing row-cost benchmark fluctuation; its gate is unchanged.
Live paid searches and real-key mutation are not part of these checks.

### Native tool consolidation (2026-10-28)

The owner requires separate mandatory `core` and `coding` groups. `coding` is the native
pi-durable `CodingTools`; `core` adds a native-style `list` tool. The previous custom
read/write/command implementations and their aliases are removed, together with their
obsolete sandbox contract. Native tool integration tests replace implementation-specific
tests; the existing coverage scope and thresholds are unchanged. Missing-group and
existing-session regressions failed before implementation. The daemon gate passes 471
tests with 95.08% lines, 87.55% branches and 90.65% functions; `list` is 100% in all three.
The macOS app passes 119 feature and 46 design tests with 95.8% configured logic coverage.
The Bots client passes 121 tests with 90.6% configured logic coverage after meaningful
selected-bot and transport tests raised the observed 88.1% shortfall. The app bundle builds.
The rebuilt app shows both mandatory groups enabled with disabled switches. Disk-source
reloading is not part of the native Registry refresh described below.

### Native Registry refresh (2026-10-28)

All built-ins register once per Harness, while one explicit group-to-extension mapping
selects the agent's capabilities from the current native Registry snapshot. Every client
subscription refreshes that selection, including cached A -> B -> A switches, without a
new wire request, runtime watch or model call. Existing answers continue running. A failed
runtime subscription closes `1011` for the existing client retry policy; a storage fault
shares one Harness failure identity across the refresh and SDK notification channels.
Same-value settings saves retry an earlier application failure instead of silently skipping it.

The final daemon gate passes 482 tests, with 95.10% lines, 87.96% branches and 90.81%
functions. `list` and the retained workspace helpers are 100% in all three measured metrics.
The Bots client gate passes 121 tests at 90.6% logic coverage; the unchanged native app lane
passed 165 tests at 95.8%. The review's two failure-path findings were reproduced by real
WebSocket/SQLite tests, fixed, and accepted on follow-up static review. Original thresholds
and exclusions remain unchanged. Third-party plugins, filesystem watchers and source-module
hot loading were not added.

```
docs/bots/                 contracts and this plan
fixtures/bots-protocol/    normative wire samples, shared by daemon and client
apps/bots/                 the daemon: own package, own lockfile, own gates
  src/core/                domain types, catalog, hub, view fold, runtime port, service
  src/protocol/            wire codec, limits, validation
  src/log/                 declared event catalogue and the layer logger
  src/runtime/pi/          pi-durable adapter, classifier, golden mapper
  src/server/              http, websocket transport, auth, singleton lock
  src/testing/             fake runtime and test helpers
  src/main.ts, config.ts   composition root; the only place env vars are read
  scripts/serve.ts         the process entry: start line, SIGINT/SIGTERM, no logic
  test/{protocol,core,log,runtime,server,e2e}.test.ts and architecture.test.ts
  test/crash/              real daemon processes: SIGKILL mid-answer, delete, lock
  test/perf/               the documented measurements with generous bounds
  test/runtime/golden/     recorded pi sequences and their frozen mapping
apps/bots-macos/           the client logic: SPM package, imported by the Eagle app
```

Gates, all run in `apps/bots`: `npm run check`
(`fixtures:check`, `npm test`, `typecheck`, `lint`, `coverage` 90/85/90), plus
`npm run test:crash` and `npm run perf`, which are separate because a real
`SIGKILL` and a real clock are not deterministic. `npm run test:runtime` and
`npm run test:protocol` run one stage's suite.

## Ladder state

Rows are the `TESTING.md` ladder. "Signed off" means the reviewer accepted that row
after a full review round; a row can be implemented and reviewed but not yet signed.

| Row | Stage | What it proves | State |
| --- | --- | --- | --- |
| 1 | 1 | every fixture decodes and re-encodes without loss | **signed off** |
| 2 | 1 | the encoder reproduces `snapshot.server.json` byte for byte | **signed off** |
| 3 | 1 | commands are validated at the wire boundary | **signed off** |
| 4 | 1 | encoded-frame, page, message, catalog and inbound budgets | **signed off** |
| 5 | 1 | unknown events are ignorable with their revision consumed | **signed off** |
| 6 | 1 | log shape: declared catalogue, failure identity, origin-only errors | **signed off** |
| 7 | 1 | no message text, prompt, title or secret reaches a log | **signed off** |
| 8 | 1 | the layer allowlist, proven by parsing all import forms | **signed off** |
| 9 | 2 | an interrupted catalog write leaves the previous catalog readable | **signed off** |
| 10 | 2 | `reconcile` finishes a delete interrupted after the move | **signed off** |
| 11 | 2 | the fake runtime satisfies the port, per bot and stateful | **signed off** |
| 12 | 2 | revisions strictly increase per bot, snapshots included | **signed off** |
| 13 | 2 | every subscriber sees the same sequence | **signed off** |
| 14 | 2 | a subscriber that falls behind is downgraded to snapshot-only | **signed off** |
| 15 | 2 | deltas coalesce inside 50 ms and keep every byte | **signed off** |
| 16 | 2 | a runtime snapshot is published at the next revision | **signed off** |
| 17 | 2 | `send` needs a subscription and answers a connection-scoped record | **signed off** |
| 18 | 2 | a repeated `requestId` returns the stored record, no new events | **signed off** |
| 19 | 2 | queued, placed and done map to one submission id | **signed off** |
| 20 | 2 | `unanswered` keeps its reason and never invents a settlement | **signed off** |
| 21 | 2 | history pages older messages, newest window untouched | **signed off** |
| 22 | 2 | resync returns a snapshot at the last published revision | **signed off** |
| 23-36 | 3 | pi-durable adapter: mapping, idempotency, failures, recovery | **signed off** |
| 37-41 | 4 | auth, handshake, close codes, catalog HTTP | implemented, review rounds closed, owner-closed |
| 42-43 | 4 | log origin and trace recipes | implemented, review rounds closed, owner-closed |
| 44-48 | 4 | registry lifecycle, singleton lock | implemented, review rounds closed, owner-closed |
| 49 | 4 | the end-to-end journey | implemented over the real adapter, owner-closed |
| 50-52g | 4 | the remaining journeys (bots, outbox, paging, ordering, overflow) | implemented, owner-closed |
| 53-54 | 4 | crash and perf suites | implemented (`test:crash`, `perf`), owner-closed |
| 55-60 | 5 | decoding, reducer, gap rule, ranked submissions, optimistic send | implemented (Bots package tests), owner-closed |
| 61-62b | 5 | the socket speaks the real daemon, close codes, gap reset | implemented (integration tests spawn the daemon), owner-closed |
| 63-68b | 5 | view models: connection, composer, outbox reconciliation, catalog, recovery | implemented (fake-port tests), owner-closed |
| 69 | 5 | dependency rules | the Bots package imports nothing from Eagle; Eagle imports it one way, owner-closed |

Current tree: 344 deterministic tests plus five crash cases and four perf
measurements, coverage 94.9% lines / 89.8% branches / 90.3% functions, `typecheck`,
`lint`, `fixtures:check`, `test:crash` and `perf` green. The daemon runs: it binds a
loopback port, checks a bearer token, serves the catalog, streams a bot over a
socket, records every crossing in the declared log catalogue, survives a `SIGKILL`
mid-answer and takes its root over again.

### What the core can do today

Signed off and usable as a library (rows 9-22):

- protocol: every committed fixture decodes and re-encodes byte-identically, commands
  are validated at the wire boundary, and frame, page, message, catalog and inbound
  budgets are enforced
- catalog: atomic `catalog.json`, a delete that survives a crash between its two
  steps, serialized mutations
- hub: strictly increasing per-bot revisions, 50 ms delta coalescing under a 96 KiB
  batch limit split between whole changes, snapshot-only downgrade with a recovery
  anchor that is never served stale, one serial fanout per bot
- view: a pure fold into `ConversationSnapshot`, with submission ranking (I14)
- service: a connection-scoped subscription whose baseline is rendered before it goes
  live, an idempotent `send` that answers the stored record and emits nothing, hub
  broadcasts for settlements, `history` paging that leaves the newest window alone, a
  single-frame `resync`, `abort` and `recover`
- log: a declared event catalogue, key whitelist, redaction and parser-enforced layer
  boundaries

What is missing, and why the product still cannot ship:

| Gap | Consequence |
| --- | --- |
| stage-4/5 signoff | five review passes are closed; the closeout pass is running |
| client surface | the MVP is complete (see "Stage 5, as built"); history paging, bot settings and an inspector that renders a bot's own state remain |

Stage 3 (rows 23-36) is signed off. Stage 4 is implemented end to end: its first
review round closed eight P1 and eleven P2 findings, and rows 42-54 are written.

## Stage 5, as built

The client is not a second app. Its logic is `apps/bots-macos` (BotsCore,
BotsTransport, BotsFeatures), and its UI is a Bots group in the Eagle main window
(`apps/macos/Sources/EagleFeatures/BotsWorkspace.swift`), rendered by the existing
`SidebarPanel`/`ConversationColumn`: a bot is a sidebar item, selecting it shows the
conversation, `+` creates one, and rename/delete are the sidebar's own affordances.

What works end to end against the real daemon: connect (token from the root), absolute
catalog, create/rename/delete (the create sheet asks for a required name, an optional
label, and a face — one of ten silhouettes and one of twelve tints, stored by the daemon
so the sidebar renders what was picked), subscribe, real streaming answers (each delta folded and
re-rendered), typing while an attempt has no text, the ranked submission rule, an
optimistic bubble replaced by the committed entry, the persisted outbox replayed on
connect, unavailable/recover, gap detection with one resync, and close-code driven
reconnection.

Deliberately not built in this pass: bot settings (model, instructions), usage,
inspector content for a bot (the inspector is emptied rather than showing another
bot's), and history paging from the transcript.

## Stages 4-5 review round: what was fixed and what is deferred

An independent review of stages 4 and 5 returned `BLOCKING 15`: three confirmed daemon
races already on this list, and twelve client/integration defects. Fixed:

- daemon: an idle close no longer clears a delete's settling window (it owns only the
  window it created); a reservation is released by a 60 s TTL instead of by a snapshot
  that may predate the admission; availability is re-checked after the record lookup
- client: `heart`/`flower` are in `BotAppearance.Shape` (a missing shape made the whole
  catalog undecodable); a send is not written when the outbox write fails and the draft
  comes back on `not_admitted`; the outbox is replayed after the first snapshot, never
  after the handshake; a send names its bot and is refused if the connection moved; a
  write failure releases the writer instead of wedging reconnects; a rejected revision
  no longer advances the gap baseline and a resync timeout retries once; a snapshot
  merges the submission ranks instead of resetting them; the outbox store merges on
  write so two windows cannot overwrite each other; hiding the open bot selects the next
  one; the catalog changing the selection moves the conversation with it; the shell shows
  a status strip with 恢复/停止/error, and a send that cannot run keeps its draft
- presentation: assistant answers are markdown dialog bubbles (headings, lists, quotes,
  fences with a language label, inline styles), the parser keeps paragraph/list order,
  handles longer fences, numbered lists and `#include`; thinking and tool results stay
  out of the answer; one attempt has one typing row; a `length` stop reason says so
- daemon: an oversized frame closes `1008` even when the socket is behind
- tests: real-socket reconnect, block-delta and ordering cases, outbox replay after the
  snapshot, draft restoration, store-level outbox merge, single typing row, the
  appearance set, and the daemon races above

A second pass found nine more P1s, mostly regressions inside those fixes; they are
closed too, with the third pass's four follow-ups: the shell binds the conversation's
draft through one accessor (one draft, so a refusal's restored text is what the
composer shows); a reservation whose status read fails keeps its slot instead of being
released; a resync deadline that finds the barrier already opened by a snapshot neither
counts it nor closes it again; and a refused request is remembered so a failed outbox
removal cannot make a later reconciliation re-send it behind the user's back. The
second-pass list: a reservation expires only after
the runtime says the request is not outstanding (time alone was not evidence); the outbox
fails closed on an unreadable file, always reads the file, and stores a terminal record
in the same atomic write that removes its entry; reconciliation runs after every
reconnect, not only the first; a failed socket write clears the queue it belonged to so
the next connection starts with `hello`; a gap is repaired by one resync and a
ten-second deadline (gapped frames neither advance the baseline nor exhaust the retries);
`abort`/`recover`/`history` name their bot like `send` does; and a refusal appends the
rejected text to a newer draft instead of dropping it.

A fifth pass found four contract defects, all closed with tests: recovery no longer drops
an admission that was in flight when the watch escalated; a subscriber the transport
backpressured is refreshed with a snapshot (bounded to one attempt per episode, so a
client that never reads cannot spin the daemon); a bot that becomes quarantined while a
subscription waits closes `4090` and retries instead of `4004`; and clicking recover while
reconnecting no longer drops the parked affordance. Its P2s are closed too: the heartbeat
follows a connection generation (a welcome no longer stops it), a refusal is a durable
tombstone written as soon as the outbox is writable, a restored settlement ranks by its
submission id, a half-spoken lock owner cannot hang the probe, the initial snapshot sets
the history flag, and the window test asserts the published transcript.

A sixth pass found three more, closed with tests: the recovery anchor of a degraded
subscriber is retried on a timer until it is delivered; a refusal becomes durable even
when the support directory is unwritable (a temporary fallback), so a restart cannot
replay it; and a command issued while reconnecting is refused instead of dropped. Its
P2/P3 are closed too: the TTL test only fails the reserved lookups, a snapshot cannot
resurrect a settled submission as pending, and the plan no longer claims there is no
client.

A seventh pass found two more, closed with tests: `snapshot.parked` (additive) tells a new
client that a task needs `recover`, and closing a window releases its socket so the
per-bot subscriber cap is not consumed by closed chats. Its P2/P3 are closed too: the
Swift fold keeps settlement ranks across a snapshot and the plan's stale rows are gone.

The third pass's four follow-ups now have regression tests: `BotsWindowTests` (the
window's one draft, the published transcript/status/actions and a refusal's restored
text), the reservation test's failing status read keeping its slot, `ResyncStateTests`
(the snapshot/deadline interleavings, including a snapshot after the retry), and the
refused-entry test (a failed removal, a reconnect, no replay, and a visible error). The
stored `SettledRequest` is applied to the ranks on selection but has no UI for its
reason.

Still deferred, with reasons: the client logging contract (`os.Logger` crossings in
OBSERVABILITY.md) is not implemented; the transport's gap/unknown/close-code/reconnect
fault-injection matrix is only unit-tested at the gap rule and exercised by the happy
path integration tests; the outbox's multi-window guarantee is tested at the store, not
through two windows; an `abort` refused on an unavailable bot still lacks an originating
record, a failed `directory.remove` can leave a closed handle that `open` reuses, and a
catalog-full refusal has no origin record; and long or hostile markdown has parser tests
but no measured layout pass.

## Phase 2: tools and herdr (both slices signed off, tool rows rendered)

A follow-on slice puts tool invocations on screen. `pi.tool-result` entries are mapped to
`role:"tool"` messages with a `toolResult` block (`callId`, `name`, text, `isError`,
`durationMs`); the assistant entry keeps its `toolCall` blocks and `toolcall` deltas grow
their arguments. The daemon clamps a result above the message budget with a
`[tool output truncated]` tail instead of the answer's oversized notice. The client pairs
a call with its result by `callId` and renders one compact row per call: name, an argument
summary, a running spinner or duration, and on click the pretty arguments and the output,
colored when the tool failed. A result whose call was trimmed out of the page is still a
row, so nothing disappears. Fixtures, the mapper, an end-to-end socket test and the
presenter all cover it; PROTOCOL.md "Tool rows" is the contract.

**Status: implemented, not signed off.** Three Codex rounds (reasoning max) reviewed it.
The first two rounds' findings are fixed (encoded-size clamp, commit ordering, typed delta
path, Swift codec parity, duplicate-call pairing, bounded rows, trim/pointer handling).
The third round leaves one P1: after a page trim drops a provisional, a later `status` or
`inbox_update` can re-publish that `streaming` id (`apps/bots/src/core/view.ts:156` only
sanitizes inside `trimWindow`), making a resync snapshot name a missing message. A P2
defensive gap remains for a `__proto__` path segment in the two fold copies
(`mapEvents.ts:606`, `view.ts:222`); upstream Chord currently rejects such a path. Both are
recorded in CHECKPOINTS as open, not fixed.

`apps/bots/src/tools/` installs the `bots-tools` extension in every Harness: `read_file`,
`write_file`, `list_files` and `run_command`, bound to `<bot dir>/workspace`, executed
without an approval gate. Paths are confined lexically and component by component (a
symlink, including a dangling one, is refused; files open with `O_NOFOLLOW` and only
regular files are read), commands run under a Seatbelt profile that denies the daemon root
and every other bot, a deadline kills the whole process group, both output streams share
one 64 KiB budget, and the child environment is an allowlist (no daemon secrets). A
refusal or a non-zero exit is a tool result the model reads. The agent's
`cwd` is the workspace, `capabilities.tools` is true, and a tool round works over the real
adapter (tests drive a faux model that calls a tool, checks the result reached the model,
and asserts the file/command effect). Tool calls already fit the wire; rendering tool
rows in the client is the next slice, so `pi.tool-result` stays off the wire for now.

The first Codex review of slice 1 (reasoning max) returned six P1s: a shell with no
filesystem isolation, a dangling-link write-through, a check/use race in path resolution,
a workspace root that trusted a symlink, a timeout that killed only the shell PID, and a
tool that ignored cancellation. The hardening above closes them; the remaining
intermediate-directory race is recorded in RUNTIME.md as a known limit (it needs `openat`,
which Node does not expose). A second review found three more: a workspace root that could
be re-bound after open, a `write_file` that blocked on a FIFO (abort could not finish), and
a `setsid` descendant that outlived the deadline. All three are fixed (open-time
`dev`/`ino` identity, non-blocking regular-file writes, `ps`-tree kill), together with its
P2s: no silent sandbox degradation, SDK budgets set as a backstop above the tool caps, one
`[stderr]` marker, a decoded-byte output budget, and a streamed page instead of a
whole-file size limit. A third review confirmed those and left one limit: a daemon whose
parent already exited is reparented and cannot be killed by a tree walk, which RUNTIME.md
now states; the same review's two page-limit defects (an unterminated last line bypassing
`limit`, and a page-budget refusal reported as "no such line") are fixed. A fourth review
confirmed the page fixes and found the output budget still counted pre-decode bytes at the
cut: a lossy decode now clips on a UTF-8 boundary and the decoders' tail is budgeted too,
and the stderr test now writes stderr (with the redirect removed). A fifth review re-ran
every probe and returned SIGN OFF: the four tools are ready as slice 1 with their
documented limits. Slice 2 (herdr: open a space,
schedule the controller, monitor, fetch, bidirectional messages) is next, as a second
extension with the same layering.

### Model gateway and setup

The model endpoint moved into the app: Settings has a `Bots 模型` tab (URL, key, model,
`测试连接`, `保存`) backed by `GET/PUT /v1/settings` and `POST /v1/settings/test`. The store
is `<root>/gateway.json` (0600, dotenv fallback), the key is write-only, and saving swaps
the process-wide `Models` (read through a getter by every Harness), moves live
conversations with `conversation.configure({model})` and rebroadcasts the catalog. The
daemon had previously been configured only by its dotenv and registered exactly one model,
which is why a bot naming another id settled `no_model`. Guidance is progressive: a bot
stays readable until a send is attempted without a gateway, then the conversation offers a
short "去设置" banner; the gate is tested (`BotsWindowTests`), the fresh-install window is
not.

## Settings for effort, compaction and tool groups (2026-10-27)

The model page now carries three daemon-wide choices, each stored in the gateway settings
and applied to every bot: the reasoning level (default `medium`, written per bot and moved
into a live conversation with `root.configure`), automatic compaction (on by default, its
thresholds capped to `BOTS_CONTEXT_WINDOW` and overridable per `BOTS_COMPACTION*`), and the
tool groups (`core` mandatory, `herdr` optional). Compaction is accepted on a 1 200-token
window in `test/e2e/compaction.test.ts`: four `pi.compaction` entries, the request context
stops growing at ~2 095 characters, and all five turns stay readable through `history`.
Known gap, unchanged by this pass: the transcript a client receives after a compaction
starts at the compaction head, so scrollback after a reconnect now depends on the `history`
paging the client does not use yet. The `tasks` capability stays false, so a running
compaction is invisible in the UI.

## Sidebar groups and sample data (2026-10-27)

Real bots now live in sidebar groups the person owns: `catalog.json` stores
`groups: [{ id, title }]` in display order and each bot records its `groupId`, with
`POST/PATCH/DELETE /v1/groups`, `PUT /v1/groups/order` for the whole order, and
`PATCH /v1/bots/:id { groupId }` to file a bot. A group that still holds a bot cannot be
deleted (`409`), because emptying it is the person's decision, not a side effect of
deleting the folder.

The sample workspace is now opt-in: `加载 Mock 数据` in 通用 is off by default, and with it
off the sidebar shows only real groups and the conversation area shows an empty state
instead of falling back to the demo transcript. With it on, the sample groups follow the
real ones.

### The client slice (2026-10-27)

The sidebar renders the daemon's groups: one section per group in the daemon's order, an
empty group included, and one fixed `未分组` section at the end that appears only while a
bot is unfiled and cannot be renamed, moved or deleted. A membership pointing at a group
the catalog no longer lists reads as ungrouped, the same rule the daemon applies.

A group's context menu renames it, deletes it, and moves it up or down; reordering sends
the whole order once through `PUT /v1/groups/order`, so the ends disable the item instead
of writing a partial order. Deleting a group that still holds a bot offers the reason in
the menu instead of the item, and the daemon's `409` message is what the window shows if
one is attempted anyway. The header's `+` is now a menu with `新建 Bot` and `新建分组`, so
a new group is not confused with a new bot; creating a sample group stays in the sample
section's own menu.

A bot changes group from its row menu (移至 → a group, or 未分组), which is the same
`PATCH /v1/bots/:id { groupId }` call with `group: null` for the latter. Drag-and-drop was
built, verified once with a synthetic slow drag, and removed the same day: a normal
press-and-move on a `Button` row never started the drag session, so the affordance was
unreliable and the explicit menu stayed instead.

## Delegation, on-demand tools, live tasks (2026-10-27)

Three capabilities landed on top of the phase-2 tool work, in the order they were asked
for.

**Subagents.** `bots-agents` gives a bot `agent_spawn` / `agent_send` / `agent_stop`. A
child is an ownerless conversation in the same Harness, configured from the caller's agent
minus these tools, so delegation is one level deep. Its turns are driven inside a tool call
and its final text returns as the tool result; the transcript keeps only that result. The
`peers` capability stays false because nothing about children crosses the protocol yet.

**Deferred tools.** The eight `herdr` tools are declared deferred and `tool_search` is
installed with them, so a request carries seven tools instead of fifteen. Loading writes the
conversation's `modelTools`, which keeps them offered for the rest of the branch. A bot
without the herdr group gets no loader.

**Live tasks.** Every open bot follows `harness.taskGraph()` and pushes one `tasks` event;
snapshots carry the same list. The capability is now `tasks: true` and the inspector renders
the list under 例行任务 — kind, status, blocked reason and owner nesting — with an empty
state instead of a blank section. The panel's sections gained one decorated header style and
their own empty states.

Known gaps: children are invisible in the sidebar until a peers surface reads them; the
task panel is read-only (no retry from the UI, although `harness.retryTask` exists); and a
deferred tool loads per branch, so a compaction keeps it but a reset does not.

## Settings: real usage statistics (2026-10-27)

The 用量与账单 page no longer shows sample numbers. The daemon keeps one row per bot and
local day in `usage.sqlite` (90 days, pruned on boot and on write), turning the runtime's
cumulative `usage` into deltas; `GET /v1/usage?days=` serves today / 7 / 30 day totals, a
padded day series and the ten busiest bots with their catalog titles. The page shows the
three totals, a thirty-day bar chart whose bars name their day and tokens on hover, and the
five busiest bots — with an empty state instead of zeros before anything runs.

## Search provider and usage sources (2026-10-28)

Settings gained 服务: one card per third-party provider, starting with DeepSeek's search and
fetch APIs. The key is write-only and stored in the user's own config (`~/.config/eagle-bots/
providers.json`, 0600), never in the daemon root or a bot directory; `测试` spends one search
and reports latency. The `search` group ships unselected by default (the doc's rule for new
optional groups), installs the same single `tool-search` loader, and both tools are deferred.
`GET /v1/providers`, `PUT /v1/providers/:id` and `POST /v1/providers/:id/test` are the wire;
the runtime now hands the saved client to the registry, so a bot whose groups include `search`
loads `web_search`/`web_fetch` through `tool_search` and books one `search` call per call.

Usage turned into a source-agnostic meter: models book token deltas, search books calls, and
`GET /v1/usage` reports per-source totals beside the bots. The old token-only day table is
migrated into the `model` source on first open. 用量与账单 gained a 来源 card; a bot that only
searched shows calls instead of a zero token row.

The 模型 page's tool list gained the 搜索 switch, and the form's group list is now the
daemon's five groups with the four old ones as the fallback, so saving settings no longer
drops a stored `search` selection. A group whose own extension is not installed contributes
nothing, not even its loader: selecting `search` without a key offers no `tool_search`.

Evidence, this pass: the daemon gate passes 497 tests with 95.1% lines / 87.8% branches /
90.9% functions (thresholds 90/85/90); `typecheck`, `lint` and `fixtures:check` are green.
The Bots client passes 126 tests at 91.5% configured logic coverage after tests for provider
decoding, the additive `sources` field and the wire round trip. The Eagle app passes 175
tests at 95.8% configured logic coverage, and the app bundle builds. Snapshot review covers
服务 (configured and unconfigured), 用量与账单 with two sources and the 模型 tool list with the
搜索 row; those snapshots answer the daemon from a stub session, so they need neither a
daemon nor a key. Not verified in this pass: a real
DeepSeek key and a live `web_search` call, and a bot switching the `search` group on against
a running daemon (the runtime path is covered by the deterministic faux-model test).

## Triggers and peers (stage 0 delivered 2026-10-28; stages 1-3 planned)

[TRIGGERS.md](TRIGGERS.md) defines the bot-side invocation port and the three
callers that will use it. Design decisions frozen with the owner:

- One port (`core/Invocation.ts`: `invoke`/`submission`/`observe`) is the only way
  a non-connection caller admits work. Queueing, batching and timing stay caller
  policy, so a caller can be replaced without touching core. Stage 0 also fixes two
  existing holes it depends on: a settled record is invisible after a restart until
  the adapter uses the durable `submissionByRequest` lookup, and an idle close can
  race an admission until the registry tracks activity generations.
- Each trigger owns a 32-item FIFO queue, evicting the oldest, and delivers to an
  idle Bot only: one frozen, merged submission per idle window, cut by the
  `MAX_SEND_TEXT` budget rather than truncated, driven by a drain pump because a run
  can finish before `submit` returns.
- `trigger` (schedule + webhook) and `peers` are two optional tool groups registered
  like every other group and deferred behind `tool_search`. The Bot's own model
  creates and manages its triggers; the app lists them read-only with a single
  enable switch. No user-facing trigger creation exists.
- The app lists a Bot's triggers in the sidebar under that bot and mirrors them in
  read-only detail, with enable as the person's only action; an additive `triggers`
  event mirrors `tasks` and the model remains the only creator.
- Transcript messages gain an additive `origin` field backed by a per-Bot
  `origins.jsonl` sidecar, written before admission and applied on all four render
  paths, so a label survives a restart and absence means `unknown`, never `human`.
- Scheduling is Bot-owned and fires only while the daemon runs: no catch-up, no
  user-registered cron jobs. External cron uses a webhook endpoint authenticated by
  a per-trigger bearer token in a header, and the daemon stays loopback-only.

Stage order: 0 interface and its contract tests (including the four adapter,
registry and lifecycle fixes it needs), 1 `trigger` group with schedule plus origin
field and app surface, 2 webhook ingress, 3 `peers`.

### Coding reports, as built (2026-10-30)

The coding group carries `pr_register` and `pr_list`: a bot reports one pull request — link,
title, one of six states — and the inspector's 编码 section draws it with that state's glyph
and colour, one click away from the link. The daemon stores reports in
`pulls.journal.jsonl` per bot (last record per URL wins, newest 20 kept) and deliberately
never queries a forge, so a state changes when the bot reports it again.

### Peers, as built (2026-10-29)

Daemon side: `core/PeerExchangeStore.ts` (durable exchange, request-keyed receipts, ten
messages per side before the exchange closes), `peers/host.ts` (catalog + invocation +
receipts, refusals with reasons), `tools/peers/tools.ts` (`peer_list`/`peer_send`/
`peer_read` and a prompt that states the budget and the stopping rule), and
`RuntimeHandle.entryById` for reading an answer. `apps/bots/test/peers` proves it with two
real Harnesses over real sqlite: a message lands as a peer-originated turn and the sender
reads the recipient's answer; ownership and receipts are the sender's only.

The read path landed the same day: `GET /v1/bots/:id/exchanges` and
`/exchanges/:exchangeId` (owner-scoped), turns that keep their message and answer, and a
client that folds a round trip into one row in both chats (`PeerExchangeRow`) and reads the
dialog's messages on open (`PeerConversationDialog`, each side in its own bot's colour, a
centred time divider whenever the conversation resumes after five minutes or more).
`peers` stays false on the wire: there is no peer frame, the app reads HTTP.

### Peers UI, as built (2026-10-29, client only)

The presentation half of stage 3 landed before its daemon side, against a fixture:
`PeerExchangeRow` (the folded line inside the transcript), `PeerConversationDialog`
(the read-only round trip, its pair chip, sender labels and trailing avatars) and
`PeerOriginRow` (whose message caused an answer) live in `EagleDesign/Peers`, with
`MockWorkspace.vesExchange` as the only data. `TranscriptEntry` gained
`.peerExchange` and an optional `from` on `.assistant` for that origin line. No
daemon record, no capability change and no wire field exists yet, so `peers` stays
false and no live bot shows one; the data source is the owner's decision A: the
daemon keeps one durable exchange record and the client reads it over HTTP once. Each stage states its exit
criteria in TRIGGERS.md §12.

### Stage 1, in progress

Shipped so far, each with its own failing test first:

1. The transcript `origin` field and its sidecar (see "Stage 0, as built" for the
   four fixes it needed), so a fired message can carry who caused it.
2. `core/TriggerStore.ts`: one journal per bot as the source of truth, mutations
   idempotent by `opId` (the SDK tool-task id) and atomic with the cap check,
   cursor/counters as engine-owned state, compaction on open.
3. The `trigger` tool group: five deferred tools, a per-bot host, install only when
   the daemon supplies that host, and the model-facing prompt section.

4. The queue and the drain pump (`src/triggers/queue.ts`, `pump.ts`): a bounded
   FIFO that evicts the oldest and counts the loss, a frozen batch cut by the
   rendered send budget rather than by truncation, and a per-bot pump that
   reconciles a batch against its submission record before it cuts again, retries
   an unadmitted batch with the same key, and takes turns across one bot's triggers.

5. The schedule tick and the producers (`src/triggers/schedule.ts`,
   `producers.ts`): cron in the trigger's own zone through the pinned `croner`, a
   cursor that is only armed, fired or recorded as missed, one queue record per
   decision, and a `TriggerProducers` that owns one pump per bot plus the single
   ticker, started after recovery and stopped before admissions drain.

6. The `triggers` surface: a bot-scoped `triggers` event with the same list on
   `snapshot`, the `triggers` capability, `GET /v1/triggers?botId=…` detail and
   `PATCH /v1/triggers/<botId>/<triggerId>` as the person's only mutation. The
   service republishes the list after every store change, so a model's own edit
   reaches the sidebar without a resubscribe.

7. The window: a `触发器` sidebar section with a one-click switch per row, the
   inspector's read-only trigger detail, the origin chip on a message whose cause
   was not a person, and the `trigger` group's switch in Settings. The sidebar's
   inline control and the `owned` section role are EagleDesign additions; a row the
   model owns offers no rename, move or delete.

8. Stage 2's webhook ingress: `POST /v1/triggers/<botId>/<triggerId>` authenticated by
   the trigger's own bearer (the daemon bearer is not accepted there), with the
   documented 202/409/413/422/429/404 matrix, a 64 KiB body cap, an `Origin` refusal,
   idempotency by `Idempotency-Key` or a body hash across the retry window, one token
   per trigger persisted 0600 and minted at boot, and counters that follow a delivery.

Both trigger kinds now work end to end: a Bot creates a trigger with its own tools, a
schedule or a webhook delivery becomes one batched turn through the invocation port, and
a person sees and switches it in the window.

9. Acceptance cases in `tests/eval` (format and cases in
   [its README](../../tests/eval/README.md)): a real daemon, a scripted Responses model,
   real tools, and checks on the transcript plus the files on disk. Eight cases cover
   chat, a coding loop, the two trigger kinds, an unconfigured search, and three
   different complex shapes. `npm --prefix apps/bots run eval` runs them; they are not
   part of `check`, because a case boots a process and writes files. The cron case found
   a real defect: a timer tick enqueued a schedule fire but never woke the pump, so only
   an unrelated idle edge could deliver it (`TriggerProducers.onTick` now drains). Not yet implemented from the stage-2
contract: the per-token bucket and `maxFiresPerHour` (the queue cap and the admission
budget are today's backpressure). Stage 3 (`peers`) is untouched.

### Stage 0, as built

The port, its four prerequisite fixes and their tests are in. `ConversationService`
implements `InvocationPort`: `invoke` is idempotent by `(botId, requestId)`, opens a
cold bot under the registry's lease, validates the key alphabet and text budget
before any runtime call, and shares the human admission chain; `submission` answers a
bot-scoped durable lookup; `observe` reports the current run state and its edges
without opening anything; `drain` refuses new work and waits for admissions already
in flight. `send` is now a thin wrapper over the same path.

The four fixes stage 0 depended on:

1. The adapter resolves a settled `requestId` through
   `Tx.submissionByRequest`, because the in-memory ledger dies with the process and
   `inspect()` lists only queued and placed work.
2. `BotRegistry` tracks a per-bot activity generation, so an idle close that spanned
   `await busy()` is abandoned when a lease was taken meanwhile.
3. Delete closes its door, drains the leases already granted under the close
   deadline, and only then takes the lifecycle window; the reverse order deadlocks
   against an `open()` waiting for that window. A miss quarantines instead of moving
   the directory.
4. The internal per-bot view is live without a subscriber, and shutdown drains the
   service before the registry closes handles.

Evidence: `npm run check` green at 527 tests, 95.41% lines / 88.32% branches /
91.38% functions over 90/85/90 thresholds; `test/core/invocation.test.ts` (13),
`test/core/invocation-stack.test.ts` (2), `test/core/registry.test.ts` (+4) and
`test/runtime/idempotency.test.ts` (+1). Two existing service tests were rewritten
because they asserted the buffering mechanism this stage replaced; RUNTIME.md's
baseline paragraph now states the new rule.

## Next work, in order

1. Finish the client surface: history paging, bot settings behind the `agent`
   capability, and an inspector that renders a bot's own state.
2. Deliver the trigger stages in [TRIGGERS.md](TRIGGERS.md) §12, starting with the
   invocation port, because every later caller depends on it and none of them
   changes it.

The extension/tool track has its own proposed sequence in
[Extensions and tools](EXTENSIONS-AND-TOOLS.md#6-planned-optional-groups):

1. Add child discovery with `agent_list`, direct-parent target validation and the
   missing negative/stop/recovery tests for existing delegation tools.
2. Add optional `memory`: `memory_list`, `memory_search`, `memory_read`,
   `memory_write`, `memory_delete`, with explicit shared/private scope. Make the
   one native discovery loader independent of Herdr in this slice.
3. Add optional `search`: `web_search` and `web_fetch`, separating URL discovery
   from page retrieval and proving bounded, cancellable provider calls.
4. Add optional `peers`: `peer_list`, `peer_send`, `peer_read`, with durable
   cross-Bot admission, observable settlement and bounded routing.

All four tool rows are planned, not implemented. New groups remain optional and
must not become default-enabled merely by extending the group-name list.

### What the adapter can do today (rows 23-36, signed off)

- `mapEvents.ts` replays recorded pi runs: append, delta, submission and status
  events, an attempt-scoped provisional, an aborted entry that replaces it, a
  withheld over-limit answer and a deferred poll that resets through a snapshot.
- `PiDurableRuntime` opens one Harness per bot over real node:sqlite, resumes
  recovery, answers a duplicate `requestId` from the stored record, aborts the
  running and queued inputs, keeps a model's tool request from crashing the run,
  pages history and turns a stalled `close` into `timeout`.
- `classify.ts` mints one failure identity per episode across the four reporting
  channels, announces one `error` event per identity, and escalates a repeated
  listener error only at the third occurrence inside a minute.

`ConversationService` (rows 17-22) is done: `subscribe` renders the current view as
the connection's baseline and goes live in one serial section, `send` reads the stored
record first so a retry is silent, `history` pages without touching the window,
`abort`/`recover` pass through behind the same subscription guard, and `resync`
broadcasts the only reply it produces, at a revision that names its content.

## Phase 1 close (owner decision, 2026-10-26)

The owner closed stages 4-5 on 2026-10-26 without waiting for another signoff round
("太细致不修，进入 tool call 开发"). Tip at close: `e70547c`. The eighth review was
interrupted on purpose and issued no verdict; its one confirmed observation — after a
daemon reopen the recover affordance can disappear because `parked` is not carried on that
path — is recorded as open, not fixed. Phase 2 (tool calls) proceeds next.

Closed by the review rounds: the three daemon races that were recorded here earlier (an
idle close clearing a delete's window, a stale snapshot releasing a reservation, an
availability check across an await) plus the transport, budget, logging, lifecycle,
client and presentation defects listed under "Stages 4-5 review round".

Deferred, not claimed fixed:

- client `os.Logger` crossing contract ([OBSERVABILITY.md](OBSERVABILITY.md), "Client
  logging") and its `LoggingTests.swift`
- the transport's fault-injection matrix beyond `ResyncState`: real-socket gap, unknown
  event with a gap, resync timeout with a fake clock, and the complete close-code matrix
  (the policy table and the resync state machine are tested; the injected journeys are
  not)
- the outbox across two real windows (the store merges on write and is tested that way;
  no two-window UI test exists)
- daemon: a refused `abort` on an unavailable bot has no originating record; a failed
  `directory.remove` can leave a closed handle that `open` reuses; the catalog-full
  refusal has no origin record
- the recover affordance after a daemon reopen (unfinished round 8, above)
- a measured long-markdown layout (the parser has unit tests; no layout pass)
- test-fidelity deferrals noted in [TESTING.md](TESTING.md): an admitted-then-unreadable
  storage fault inside the adapter and a retired-watch integration injection
- history paging from the transcript, bot settings behind the `agent` capability and an
  inspector that renders a bot's own state

## Open review queue

Stage 4 has had three review rounds. The third found eight P1 and ten P2 findings;
they are closed or recorded below. The second round found nine P1 and nineteen P2;
every defect among them is closed. The first round's eight P1 findings were closed,
in order: the
lock port derived from a non-canonical root, a delete that ran on after a timed-out
close, a handle that a new subscription could still take while closing, a baseline
the socket sent twice so an older snapshot could paint over a newer append, a
`recover` whose events updated a different Bot object, a service that kept a closed
handle, a socket close that never unsubscribed, and a `validateCommand` the wire
never called. Its eleven P2 findings are closed too, in order: a refused upgrade
keeping its connection slot, the missing eight-subscriber cap, an error frame before
`welcome`, a second in-flight subscribe that was not a protocol violation, two
refusal identities for one refusal, an unbudgeted 33rd admission and an unmeasured
`bots` broadcast, a token file that kept its mode, core re-originating a runtime open
failure (which its own guard then refused to log), a close timeout logged as success,
and a day boundary that left a sixth log file. Rows 44 and 49 stopped proving their
properties over the fake runtime.

The first round also closed the rest of the observability contract: every declared
event now has its emit site, the catalogue is asserted equal to the document, a run's
first `status` is attributed to the send that caused it, and an over-long
conversation is trimmed to the page budget with `truncatedBefore` kept.

The second round's findings, closed in area order: an open during a close creating a
second Harness (and the close then dropping it), a delete that ran past an in-flight
warm-up open, a run-time storage failure that never made the bot `unavailable` so
`recover` reused the dead handle, a snapshot page bounded by count but not by bytes,
transport backpressure that the hub could not see, a check-then-submit admission race
past the 32-entry budget, a create race past the 200-bot cap, a catalog event that
could arrive before `welcome`, a per-bot shutdown deadline instead of one shared
budget, refusals with no originating record, a `history` failure split across two
identities, an invalid trace written to the log, an upgrade accepted on any path, a
failed unrelated command clearing the subscribe guard, catalog states that never
followed the run, a token file two first starts could overwrite, and a perf bound that
was looser than the document. Its test-fidelity findings are closed too: the catalogue
test now proves an emit site rather than a declaration, the real-Harness test holds the
warm-up open to prove in-flight sharing, the overflow journey joins during the
withdrawal window, the delete crash test runs the production `remove`, the outbox
journey covers an admitted input whose record read failed, quarantine retry recovery,
a second crash without any provisional, two daemons starting at once, a junk sqlite
beside a healthy bot, and the catalog following a run. Then a third round found eight
P1s (a handle held across a close or delete, history byte-paging that skipped
messages, a snapshot budget that ignored the rest of the frame, an unavailable
snapshot the decoder would reject, leaking or early-freed reservations, a
backpressure bound only on the hub path, a silent client holding the lock server,
and concurrent `recover` attaching two watches); a fourth round found five more in
those fixes (reservations counted twice or leaked, an escalated watch dropping a live
Harness so `recover` could open a second owner, two concurrent subscribes building two
views and so bypassing the eight-subscriber cap, and a summary only budgeted in its
healthy form). A fifth round found three more (the delete window being replaced by
its close, a snapshot reconciling a reservation whose submit had not returned, and an
unavailable bot bypassing the admission budget through its still-live handle). All are
closed, most of them with a test that fails without the fix; the sixth round's
remaining races are listed below rather than claimed as fixed.

Four test-fidelity findings remain deferred with their reasons: the outbox's
admitted-then-unreadable case is asserted at the service and adapter boundaries
because no fault can be injected at that read; a retired-watch reattach has no
integration injection because pi-durable exposes no hook (the classifier and reattach
paths are tested); the transport's unsent-byte threshold shares the hub's proven
mechanism and has no slow-TCP test of its own; and I14's ranking is a client reducer
duty in stage 5.

Stage 3 (rows 23-36) is signed off. Its review rounds closed, in order: a
fail log record built from another layer's identity, a reattach that dropped its
recovery snapshot, a listener escalation counted per notification, a park found
during `open` that no subscriber could see, `pending` rebuilt from the ledger
instead of the snapshot, `task_failed` bypassing the event dedupe, failure ids
colliding across harnesses, `hasMore` counted from raw entries, a settled record
unreadable by request id, progress wearing the watching connection's trace, an
attempt id reused after a deferred poll, an oversized re-announcement, an unstable
notice timestamp, and a baseline that could arrive after newer content.
Stage 2 (rows 9-22) closed these rounds, in order:
revisions consumed before a delta was folded, unfaithful delta merging, a silently
dead degraded subscriber, reentrant fanout, a missing byte trigger, non-wire byte
counting, a detached subscriber still pumped, a fake-runtime toolcall path read from
the wrong root, a lost streaming pointer, history truncated by a window rerender,
unbounded batches inside one event, a stale anchor served as current, a starved
cross-subscriber pump, an evicted recovery snapshot, one test that could not fail,
a service view that was stale on a later connection, a connection registered after
its open, a baseline that raced a flushed delta, a release buffer that went live too
early, failures that lost their classification, snapshots that bypassed submission
ranking, a resync reply that could be replayed after a newer frame, and a resync
snapshot without its command trace.


Physical first round now completes real A→B→A SDK continuation through5/10/14/19
entries, offline B work/A cold recovery and dual-daemon restart with passive0.
Exact6575 execution copies/helper inputs and real A-return call are bound by
physical-first-round-final.json SHA dc9c65da9060faa5959bc5e384bae218b8467f8c51eec14b2915fdd94c2eba77.
This is controlled-provider/API/SDK/local-tools scope over the owned shared HTTPS
backend; composer, physical direct/switching and remaining PR scenarios stay open.
All-path status is now normally delivered as193f75bd/tree73695d14, with accepted
source863cd483 and final receipt25b2ea37. Both hooks/own ref/clean0/0 are verified.
Next is physical scene5 over the genuine Tail Self routes supplied by Root,
using only owned application endpoints/connection barriers and the isolated
Miniflare backend. The closed6575 API/SDK history round remains unchanged.
Scene5 uses a product Self-only listener (`BOTS_SYNC_PORT=0`), real mutual-auth
pages, actual network refusal/cache fallback and two spaced full probes/30s
stable return. No CLI inventory or Tail settings change; report Root's DERP
scope honestly. Minimum native P5 and the remaining physical PR scenes follow.
The short execution contract is `.local/sync-physical-scene5/CONTRACT.md`.


Scene5 API/SDK execution on new owned193f copies now proves actual product
Tail Self direct→owned R2 cache→stable direct. A original5/B continuation10,
B cached continuation14 and final direct continuation18 entries preserve exact
heads, raw bodies/origins/sections and six selected resource files. The final
B native request completed once; later bridge output truncation affected only
evidence retrieval and did not trigger a repeated run. B endpoint recovery to
stable direct took34.691s, with complete mutual-auth probes22.307s apart and
conservative observed cache residency79.055s. Passive execution delta0; actual
provider calls A2/B6 and local runs A1/B3 account for the intended local runs.
Receipt: `.local/sync-physical-scene5/physical-scene5-final.json`.
The initial warmup has one relay exchange; it is retained, not counted as a
relay history-supply pass. Cache completion uses two actual cache/get200 calls;
returning direct/new head adds no cache/get or relay/exchange. Application direct
uses genuine Tail addresses; Root observed DERP(tok), not proven UDP P2P. The
fallback is isolated Miniflare/R2, not deployed CF. Actual A/B copies741/697,
reused dependency paths and each native helper are separately bound. Native
composer/context/merge P5 and remaining physical PR scenarios, including owned
72h online-holder supply, remain open. No old6575 history/gates are rerun.
