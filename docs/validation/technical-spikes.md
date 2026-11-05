# 阶段 0 技术验证

[文档导航](../README.md) · [实施计划](../planning/IMPLEMENTATION.md) · [运行说明](../USAGE.md)

验证日期：2026-11-05，Asia/Shanghai。基础工程与本轮探测已落地，**阶段 0 尚未全部验收通过**。游戏最小采集／同步／发送链路、arm64 推理、模型并发、SQLite 和系统语音得到新证据；引擎规则与立直映射、本地规则、B站与 OBS 音轨仍有门槛。保持 `automationEnabled=false`，不能开始无人值守运行。

后续进展：已实现[阶段 1 状态／执行链路](./state-foundation.md)、[恢复故障测试](./recovery.md)及[生产桥接实场验收](./phase1-live.md)。新桥接使用统一请求号分配，已验证普通弃牌、完整同步、重连和发送前暂停；无人值守倒计时／自动和牌读回、音轨和许可仍有门槛。以下阶段 0 的历史测量与探针限制保持原始范围。

## 环境与固定版本

| 项目 | 本轮实测 |
| --- | --- |
| 系统 | macOS 27.2 / 26B123，Darwin arm64 |
| 版本管理 | vfox 1.0.13；nodejs 插件 0.5.4，rust 插件 1.1.2 |
| Node / npm | 24.22.1 / 11.19.1，由 vfox 下载并按项目固定 |
| Rust / Cargo | 1.93.1 / 1.93.1，`aarch64-apple-darwin`，由 vfox 下载 |
| TypeScript / Node 类型 | 5.9.3 / 24.10.1；原生 TS 执行，`tsc --noEmit` 检查 |
| SQLite | `node:sqlite`，随 Node 固定为 3.53.4；不额外加载 native 驱动 |
| protobufjs | 7.5.4 |
| ego | CLI 技能指南 2.2.0；浏览器运行时路径含 0.6.2.5 |
| 雀魂 | 当前登录页面 `4.0.51`，`chs_t`，现场重新核实 |
| OBS | 本机安装 33.0.1；未完成音轨录制验收 |
| 语音 | `Tingting`；WAV / PCM S16LE / 单声道 / 24000 Hz |
| 协议与证据版本 | runner RPC v1；探测证据 schema 1；正式 replay schema 和 reducer 尚未实现 |

机器可读版本见 [`config/versions.json`](../../config/versions.json)、[`.vfox.toml`](../../.vfox.toml)、[`package-lock.json`](../../package-lock.json)、[`Cargo.lock`](../../native/engine-runner/Cargo.lock)。Node 下载时 vfox 验证了归档校验和。Rust 插件提示未提供校验和，下载后归档已被插件清理，本轮未声称完成该归档的摘要复验。

## 验证结论与失败出口

| 门槛 | 证据类型与实测结果 | 采用结论／限制 |
| --- | --- | --- |
| ego 持续采集 | 当前客户端联调：记录 86 个发送与 120 个接收帧的元数据，3 条连接，本地缓冲无溢出；游戏记录含 26 个连续 action（step 0—25） | 最小链路通过。正式适配仍需连接代际、心跳停滞、队列溢出关闭执行与完整去重；不能把本地计数当源游标 |
| 房型与 UI | 当前客户端联调：建立四人东风、300＋0 秒友人房，三个电脑添加响应成功；请求／响应的 `player_count=4`、`mode=1`、`time_fixed=300`、`time_add=0` 与页面一致 | 该房型通过。自动和牌左侧“和”从灰变绿，完成视觉读回；尚未实测自动和牌触发和跨重连设置恢复 |
| 实际发送与确认 | 当前客户端联调：先以 UI 捕获合法摸切请求；再由页面探针发送 `inputOperation`：`type=1,tile=2z,moqie=true`；请求 60001 收到成功回执，随后收到 seat 2 / step 18 / `ActionDiscardTile(2z)` | 普通摸切最小链路通过。成功回执与游戏事实分别保留；请求到回执 145.5 ms，到权威事件约 145.6 ms，仅一个样本 |
| 最终发送暂停校验 | 受控当前页面验证：获取许可后递增 epoch，再用旧许可发送，得到 `FENCE_STALE`，网络记录数量不变 | 探针内校验通过。尚未连接 Actor、持久化意图和生产单执行器；不能用此代替阶段 1 的暂停全时序验收 |
| 完整同步／重连 | 当前客户端联调：主动 `syncGame(round_id="",step=0)` 返回当前小局历史；页面重载后客户端自然恢复，响应 next-step=26，26 个 action 全部可解码，`ActionNewRound` 含 13 张己方可见手牌 | 传输与解码通过。正式 reducer 对账尚未实现；探针不从恢复摘要建立可执行状态，重连后未重发旧动作 |
| 当前协议 | 当前公开资源提取：4.0.51，11 个 Protol 模块、443 个 RPC、9280 行 proto；提取结果与固定 Akagi 资源摘要一致 | 仅本次提取证明当前版本相符，不将上游历史版本自动等同当前。字段见下表，罕见动作与截止时间边缘仍待实测 |
| Akagi arm64 | 本机集成：release 构建、权重装载与合成局面推理成功；重复 replay 幂等，内容冲突拒绝；20 次热推理 P50 4.29 ms / P95 5.57 ms，首次 6.75 ms，装载 434 ms | 采用作离线候选引擎。仅合成开局；实际动作提交预算未测。上游固定 Tenhou 默认规则，尚不能按友人房完整规则投入自动运行 |
| 红五／立直／鸣牌 | 契约／纯逻辑：红五与普通五区分，碰的目标／消耗牌保留；首选立直在合成局面出现过，但缺 `tsumogiri`，封装返回 `INCOMPLETE_ENGINE_ACTION` | 立直门槛未通过。禁止猜参数；后续需补权威弃牌实例映射、所有吃／杠组合及唯一 actionId 匹配。未实场覆盖这些执行分支 |
| 本地规则 | 本轮没有实现经验证的向听／进张与安全弃牌算法 | 未通过；本地规则失败或未实现时关闭程序提交，不将任意摸切称为可靠降级 |
| 模型服务 | 真实配置服务：模型 `gpt-6.1-sol`，格式配置 `none`；严格 JSON 输出通过；单请求 3423 ms，并发两请求 3048 / 4394 ms，无 429；受控本机 HTTP 测试覆盖超时、非法候选、自由文本、额外字段 | 暂采用总并发 2、保留 1 决策位的 Broker。只有一次同时请求对，不是持续容量保证；`json_object/json_schema` 未配置，未测试；取消不证明远端释放容量 |
| SQLite | 本机集成：WAL、STRICT 表、事务提交与回滚通过 | 采用内置驱动；正式领域迁移、存储 worker、outbox 属阶段 1 后续内容 |
| 中文语音 | 本机集成：合成约 578 ms，音频 3.257583 秒；真实 RIFF/WAVE 和 `afinfo` 验证；afplay 正常退出，受控 SIGTERM 取消得到关闭回执 | 合成／播放器进程完成与取消通过。未证明物理扬声器音量或 OBS 实际收音；不把合成完成当播放完成 |
| B站 | 没有指定直播间及消息源／稳定身份配置，本轮未连接、未发消息 | 门槛待验；阶段 4 前补真实身份、逐条消息 ID、自发回声、回执和统一发送出口。当前不提供收发能力 |
| OBS 音轨 | 检出 OBS 33.0.1；本机 4455 端口未发现可用控制连接；未产生双音轨录制 | 门槛待验；需要独立的游戏／语音采集与本地录制证据。没有仅凭安装成功标记通过，也没有修改用户场景或推流 |
| 上游许可 | 核查固定源码 LICENSE / NOTICE、模型来源与摘要；登记实际依赖 | 见 [UPSTREAM.md](../research/UPSTREAM.md)。模型独立授权及训练资料使用范围未获额外证明，先限定本机评估；不交付可分发模型包 |

## 当前协议的关键发现

客户端 bundle：`3c0ce0802ed3ca8946842693db3e58f4d8945f37`。协议 SHA-256：`1c332959d97fc1e86cb2c3eb5df625dec25cc61129bce1f07e5db63d93413502`；RPC map SHA-256：`c25d385cf61f41d617a71af7701b98410b0df03df14c7c90bbd607b7b5d11953`。

| 语义 | 当前提取／实测来源 | 本轮限制 |
| --- | --- | --- |
| 房间规则 | `ReqCreateRoom.player_count`、`GameMode.mode`、`detail_rule.time_fixed/time_add`；建房响应读回 | proto 默认字段不一定等于服务器最终补齐的全部规则，不能把 `defaults:true` 的 false 直接当最终规则 |
| 新小局 | `ActionNewRound` 的 `chang/ju/ben/tiles/scores/doras` | 本轮仅东一局，不将一次观察推广为连庄／整场结算验证 |
| 游戏动作与顺序 | `ActionPrototype.step/name/data`，解码后的 `ActionDiscardTile` 等 | step 为当前游戏 action 顺序；跨同步／新小局去重语义仍需 reducer 验证；WebSocket requestId 仅用于响应关联 |
| 完整同步 | `ReqSyncGame.round_id/step`、`ResSyncGame.step/game_restore`、`GameRestore.actions/snapshot` | 本次请求空 round_id / step=0 得到完整当前小局；恢复响应的 step=26 是下一个位置，最后 action step=25 |
| 可选操作 | `OptionalOperationList.operation_list/seat/time_add/time_fixed` | 实场自己摸牌时 type=1；其他操作 type 尚未逐项确认 |
| 倒计时 | 房间 `time_fixed=300`；操作窗口 `time_fixed=300000`、`time_add=0`，页面对应 300 秒倒计时 | 存在秒／毫秒区别。尚未验证服务端绝对截止、传输耗时补偿与 near-deadline 行为，暂不固定提交安全余量 |
| live／restore 编码 | live action 的 bytes 需要位置相关 XOR；GameRestore action bytes 直接 protobuf 解码 | 两条路径分别验证，不能对 restore 再 XOR |

阶段 0 采用有限页面探针。诊断 RPC 使用 60000 起的独立测试请求号，**还没有与客户端统一请求号分配**；不能把本次未冲突推导为生产并发安全。后续 GamePort 必须解决这一点，以及 processInstanceId、一次性许可、待处理消息、动作窗口与持久化意图检查。探针不属于生产 `GamePort` 实现。

## 证据与复现

本轮本机证据保存在被忽略的 `data/validation/`：

- `room-probe.json`：建房请求／响应的允许字段，未保留房主身份。
- `game-probe-before-reconnect.json`：游戏可见事实与元数据；不含认证帧正文、Cookie、token 或对手隐藏手牌。
- `game-probe-after-reconnect.json`：恢复动作解码摘要，己方 seat 与恢复范围。
- `engine-latest.json` 和 `engine-*.json`：合成场景、模型摘要、游标验证和推理分布。
- `model-*.json`、`speech-*.json`、`storage-*.json`、`protocol-*.json`：各探测结构化记录；音频在 `data/audio/`。

这些是协议探测证据，**不是正式可确定性重放夹具**；部分鸣牌数据有意只保留摘要。阶段 1 需重新建立符合 replay manifest／事件 schema 的完整脱敏资产。本轮没有引用历史“10 项测试通过”。

复现命令与当前探针使用边界见 [USAGE.md](../USAGE.md)。自动验证通过：TypeScript 检查、4 项 Node 契约测试、2 项 runner 进程契约测试、1 项 Rust 动作边界测试。合成引擎基准另行运行，不计为实场测试。浏览器验证后恢复原始 send、移除监听，确认两个探针全局均不存在；页面交还用户，未运行连续自动出牌。

## 下一步

阶段 1 可以开展单写者 Actor、正式状态／存储迁移、脱敏事件与 reducer、同步对账、合法候选和单执行器。开始自动提交前先补：统一请求号、完整规则读回、恢复对账与动作 deadline／暂停时序。引擎规则、立直及其他动作映射未完成前保留离线模式；B站与 OBS 未闭环前不宣称完成直播验收。
