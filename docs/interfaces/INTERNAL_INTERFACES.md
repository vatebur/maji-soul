# 内部模块与进程接口

[文档导航](../README.md) · 接口

契约版本：v1，更新日期：2026-11-13。状态：目标设计与标注的已实现子集；常驻直播装配见第 9 节。本文落实 [架构](../design/ARCHITECTURE.md) 中的 port、事件、Worker 和引擎进程边界；领域结构以 [DOMAIN_MODEL.md](../design/DOMAIN_MODEL.md) 为准，对外服务见 [API.md](./API.md)。这里定义的是本项目的接口，不声称上游已经提供这些方法或服务。

当前落地类型见 [`types.ts`](../../src/domain/game/types.ts) 与 [`StoragePort`](../../src/ports/storage.ts)。[阶段 1 实现范围](../validation/state-foundation.md#相对目标契约的实现子集)记录源键、游标、候选及同步子集。执行模式为 dry-run／contract-test／live；[ProductionTransport](../../src/application/game/executor.ts) 经持久化 dispatching、Actor 许可和浏览器最终栅栏发送，暂停需等待 `awaitControlBarrier()`。SQLite schema v2 保留两种真实／契约确认来源。[实场限制](../validation/phase1-live.md)仍适用；下文未实现的方法继续作为目标，不能直接当成生产入口。

已落地的生命周期扩展：`HandEnded.matchEnded` 表示等待整场结果，`AuthoritativeSync.terminal` 保存完整小局／可选整场结算；投影保留 `handResult`、`matchResult` 和 `matchEndPending`。`GameCoordinator` 串行应用边界／同步，边界入队前调用 `suspendForBoundary()` 撤销旧许可；`StoragePort.inspectMatch` 跨会话读原台账，`markDispatching` 与 `assertDispatchCurrent` 在发送意图及异步准备后复核最新小局与未决动作。这些方法不创建新整场。证据和观察入口见[跨小局协调](../validation/lifecycle-coordination.md)。

## 目录

- [1. 共同规则](#1-共同规则)
- [2. 游戏适配 GamePort](#2-游戏适配-gameport)
- [3. 决策、模型与解释](#3-决策模型与解释)
- [4. Rust 引擎 Runner 协议](#4-rust-引擎-runner-协议)
- [5. 弹幕、内容与语音接口](#5-弹幕内容与语音接口)
- [6. 存储与可靠通知](#6-存储与可靠通知)
- [7. Worker 消息协议](#7-worker-消息协议)
- [8. 必须联调的契约场景](#8-必须联调的契约场景)
- [9. 常驻直播装配（已实现）](#9-常驻直播装配已实现)

## 1. 共同规则

同进程接口使用 TypeScript Promise／AsyncIterable，取消信号为 AbortSignal。跨线程／进程只传可序列化 DTO，不传函数、数据库句柄、页面对象或 AbortSignal。

所有输入在边界做运行时校验。每个异步任务带 `taskId / scope / deadlineAt / generation`，适用时附配置修订或控制代际。取消只是要求停止工作，不证明外部请求未发生；任何迟到结果都要由调用者再次校验有效性。

错误统一为：

```ts
interface PortError {
  code: string; // 本文列出的稳定错误码
  message: string; // 已脱敏
  effect: 'none' | 'applied' | 'unknown';
  retry: 'none' | 'same-task' | 'after-sync' | 'after-restart';
  sourceEventIds?: string[];
}

interface TaskContext {
  taskId: string;
  scope: { sessionId: string; matchId?: string; handId?: string; decisionId?: string };
  deadlineAt: string;
  generation: number;
}
```

调用顺序、窗口权限和最终事实由 application 层拥有。adapter 不能通过重试、私有计时器或恢复回调自行增加游戏动作。离线回放装配只读／模拟 ports，不连接真实游戏、弹幕发送或音频播放出口。

## 2. 游戏适配 GamePort

### 2.1 方法契约

| 方法 | 输入 | 输出 | 副作用与确认 |
| --- | --- | --- | --- |
| `connect` | 本机桥接 profile、processInstanceId | `BridgeCapabilities` | 建立监听，不开局；能力由当前实测和版本决定 |
| `observe` | 取消信号 | `AsyncIterable<GameObservation>` | 只提供归一化可见事实；断线／缺口显式报告 |
| `inspectRoom` | 取消信号 | `VerifiedRoom` | 只读，包含读回时间、规则和来源证据 |
| `createOrReuseRoom` | `RoomTarget, RoomPermit` | `VerifiedRoom` | 按 roomCommandId 幂等推进；建房结果不明先检查已有房间 |
| `setAutoWin` | `enabled, TogglePermit` | `VerifiedToggle` | 必须读回；未验证时返回 unknown，不以点击成功代替开关状态 |
| `startMatch` | `FencedRoomCommand` | `CallReceipt` | 只有协调器可调用；收到 MatchStarted 后才确认整场开始 |
| `synchronize` | `SyncRequest` | `AuthoritativeSync` | 获取当前权威信息，不自动执行任何动作 |
| `execute` | `FencedActionCommand` | `CallReceipt` | 只有执行器可调用；回执不代表实际动作确认 |
| `close` | 取消原因 | 完成 | 移除本程序监听，停止新提交，不退出用户账号或解散房间 |

`BridgeCapabilities` 包含 bridgeVersion、clientVersion、protocolVersion、支持的动作类型、同步能力、源游标是否可靠、截止时间来源是否已验证、可读回的 UI 开关。能力缺失返回 `UNSUPPORTED_CAPABILITY`，不能假装支持后再猜测执行。

`RoomTarget = { players: 4, length: "east", displayTimeSetting: "300+0", computerSeats: 3, reuseRoomId?: string }`。`VerifiedRoom = { room: FriendRoom, verifiedAt, evidenceIds }`。其他房间规则全部读回记录，不在适配器中静默覆盖。

`RoomPermit` 包含 roomCommandId、sessionId、processInstanceId、controlEpoch、permitId、expiresAt；startMatch 另带目标 roomId 和已验证规则摘要。`TogglePermit` 增加 `purpose: "initialize" | "resume" | "pause-cleanup"`：pause-cleanup 只允许关闭自动和牌，不能利用清理权限重新打开。

### 2.2 入口观察与持久化事件

```ts
interface GameObservation {
  schemaVersion: 1;
  observationId: string; // 当前采集代际中的本地消息 ID，不是可靠源序号
  connectionEpoch: number;
  source: 'majsoul-network' | 'majsoul-sync';
  sourceCursor?: string;
  sourceDedupKey?: string;
  occurredAt?: string;
  receivedAt: string;
  type: GameObservationType;
  payload: GameObservationPayload;
}
```

type 与 payload 是下表的判别联合，不允许任意对象；表中已有领域类型引用模型文档。

| type | payload 必需信息 | 归约约束 |
| --- | --- | --- |
| `RoomVerified` | `room: FriendRoom, verifiedAt, evidenceIds` | 只有完整读回后才可用于自动开场 |
| `MatchStarted` | `roomId, ownSeat, initialScores`，可选 gameMatchKey | 分配／对账 matchId，重复事件不新建整场 |
| `HandStarted` | 小局序号依据、`initialView: HandInitialView`，可选 gameHandKey | actor 分配 handId、锁定 pendingMode；适配器不能指定 activeMode |
| `TileDrawn` | `actor, tile: Knowledge<TileCode>, tilesRemaining` | 自己的牌必须可见；他家隐藏摸牌使用 known=false |
| `TileDiscarded` | `actor, tile, tsumogiri: Knowledge<boolean>, riichiDeclaration` | 去重后形成 ObservedAction；真实来源未知时不猜 program |
| `MeldDeclared` | `meld: Meld`，己方操作时有可核验的消耗牌关联 | 红牌、来源和杠类型完整；否则暂停同步 |
| `RiichiDeclared` | `actor`，如已公开则带 discardTile | 声明不等于具体弃牌已确认 |
| `RiichiAccepted` | `actor, scores, riichiSticks` | scores 为四家绝对分数，不重复累加扣分 |
| `DoraRevealed` | `indicators: TileCode[]` | 使用当前完整列表，重复事件不能追加两遍 |
| `OperationOffered` | `window: OperationWindow` | 候选由已验证协议和规则共同构造，保留截止时间来源 |
| `OperationClosed` | `windowId, reason` | reason 为 completed／superseded／expired／hand-ended；旧决策失效 |
| `HandEnded` | `reason, scores, winners, resultLabel` | 只采用已确认可见结果；unknown 原因记录为 other-verified 并保留事实说明 |
| `MatchEnded` | `scores, ranks` | 四家绝对结果，整场计数只增加一次 |
| `Disconnected` | `code, recoverable`，可选 lastSourceCursor | 立即关闸；不继续使用旧窗口 |

`initialScores / scores / ranks` 是键为 `"0".."3"` 的完整对象。`HandInitialView` 由 GameState 去除本地 sessionId／matchId／handId、代际、stateVersion、trust／trustIssues、latestAction／operationWindow 得到；它包含自己的可见手牌、四家公开状态和全部公共场况，unknownFields 仍保留。输入缺少关键字段时不伪造 HandStarted 完整视图，报告同步缺口。

`GameObservation` 先被检查和去重，再由 GameActor 分配本地 eventId、session／match／hand 关联和持久化 sequence，形成架构文档中的 `GameEventEnvelope`。只有事务提交后的事件才能给决策和直播消费。`SyncApplied` 由 actor 验证并提交同步结果后产生，不允许 adapter 自行宣布 trust=trusted。

### 2.3 同步响应

`SyncRequest` 带 syncId、当前 connectionEpoch、已知 room／match／hand 标识、需要对账的 attemptId，以及取消期限。返回结构：

| 字段 | 含义 |
| --- | --- |
| `syncId, connectionEpoch, receivedAt` | 对应请求与新的采集代际 |
| `coverage` | complete-current-state／partial；partial 不可打开执行闸门 |
| `room` | 读回的房间与自动和牌状态 |
| `gameMatchKey, gameHandKey` | 源端确实提供时使用，不能由文本“东一局”代替唯一身份 |
| `currentView` | 完整当前可见局面；partial 时允许缺省，不用半截对象冒充完整 GameState |
| `missingFields` | 不可确认的关键字段列表 |
| `historyCoverage` | complete-hand／partial／none |
| `handHistory` | 已去除认证和隐藏信息的本小局观察序列；带可靠去重依据 |
| `observedActions` | 可用于核验未决提交的权威动作事实与来源引用 |
| `sourceCursor` | 源端支持可靠游标时提供 |

`currentView` 与 HandInitialView 使用同一公共基础，另可有 latestAction／operationWindow。完整当前状态不等于完整历史；GameActor 判定游戏是否可恢复，EngineAdapter 独立判定引擎历史是否可恢复。同步无法证明具体动作时保持该尝试 uncertain，不能因为窗口消失就标记为成功。

### 2.4 执行许可与调用回执

```ts
interface ExecutionFence {
  processInstanceId: string;
  sessionId: string;
  matchId: string;
  handId: string;
  decisionId: string;
  windowId: string;
  stateVersion: number;
  connectionEpoch: number;
  controlEpoch: number;
}

interface FencedActionCommand {
  attemptId: string;
  actionId: string;
  fence: ExecutionFence;
  permitId: string; // 执行器生成的短期、一次性内部许可
  expiresAt: string;
}

interface CallReceipt {
  callId: string;
  delivery: 'not-sent' | 'sent' | 'accepted' | 'rejected' | 'unknown';
  observedAt: string;
  remoteReceiptRef?: string; // 脱敏引用
  error?: PortError;
}
```

actionId 必须在本决策的候选注册表中查得，不接收调用者注入的原始 wire payload。发送前检查所有 fence、许可、预算和待处理游戏消息，先持久化发送意图；sent／accepted 都继续等待游戏事实。

对于多步骤立直，每个步骤拥有同一 attemptId、递增 stepIndex、前一步确认事件和当前状态版本的新许可。操作步骤与回执也需保存；取消后不能拿旧 permitId 续做。`FENCE_STALE / WINDOW_CLOSED / PERMIT_EXPIRED / ACTION_NOT_LEGAL / INGRESS_PENDING / DEADLINE_EXCEEDED` 都拒绝新发送；已发送结果不明用 `ACTION_UNCERTAIN`，先同步。

## 3. 决策、模型与解释

### 3.1 DecisionProvider

```ts
interface DecisionProvider {
  decide(snapshot: DecisionSnapshot, signal: AbortSignal): Promise<DecisionResult>;
}
```

快照深冻结，输入仅含该小局已知信息和 executor 有权选择的候选。结果必须同时匹配 decisionId、stateVersion、候选成员与本次 provider。适配器可以产生有来源的 evidence；LLM 自述原因不能自动成为事实。

失败码包括 `PROVIDER_UNAVAILABLE / MODEL_TIMEOUT / INVALID_MODEL_OUTPUT / UNMAPPABLE_ACTION / ENGINE_STATE_MISMATCH`。协调器在可信状态和预算内使用 local-rule；它使用完全相同的接口，不直接调用 execute。客户端自动和牌窗口不创建 provider 选择任务。

### 3.2 ModelBroker

`request(ModelTask)` 只接受已注册的 purpose：decision／explanation／viewer-answer。ModelTask 带 taskId、profileId、TaskContext、purpose、输入 DTO 和 responseContractVersion；profileId 只能引用本机已有配置，任务不传密钥或任意 base URL。

服务返回 taskId、generation、profileVersion、elapsedMs、结构化结果或 PortError。Broker 负责请求名额与超时，结果的语义和是否仍有效由调用模块检查。默认总并发 2、保留 1 个出牌名额；服务实际能力须验证，取消本机请求不等于远端释放名额。

| purpose | 输入 | 允许的模型结果 |
| --- | --- | --- |
| decision | DecisionSnapshot 的允许视图与合法候选 | `{actionId, reason?}`，拒绝其他动作字段 |
| explanation | 冻结记录、已确认动作、允许的事实／指标模板、角色修订 | `{claims, personaText?, limitations}` |
| viewer-answer | 过滤后消息、有限互动历史、明确引用的决策与事实、角色修订 | `{claims, conversationalText?, replyText?, limitations}` |

`claims` 是 `{templateKey, evidenceIds}` 数组，只可选择服务端提供的模板和证据；具体牌张／数值由模板渲染器填入，不能由 LLM 自填。纯聊天可以没有 claims。对局结论超出已有模板时说明限制；自由角色文本不能增加未验证的事实。输出经格式、引用范围、内容规则和发布有效性检查后才生成 Content。

`cancel(taskId, generation)` 使本机任务失效；即使结果已经生成，也不得恢复旧决策、旧提问或已取消的内容。请求超时预算取配置与剩余动作／内容寿命的较小值。

当前 console 装配使用 `CommentaryService`，解说和历史问答均采用 `{claims, personaText?, limitations}` 的受限结果，尚未实现自由聊天。服务从弃牌 outbox 经权威确认查找原始 DecisionSnapshot，未确认的尝试不作为动作归因。事实模板限于已观察弃牌、唯一合法动作／立直后强制摸切、保留红五、对手立直数及己方分数；具体牌张和数值由服务端渲染，personaText 只能选配置中的口头禅。超出模板范围保留限制说明。

生成工作独立于回放推进，最多 16 个等待任务，观众问答优先于尚未开始的弃牌解说。单任务预算最多 8 秒且受内容到期时间约束。模型适配器支持既有三种 JSON 模式，请求最大 256 KiB、响应最大 64 KiB。`ModelBroker(2)` 在单进程内保留一个决策名额，独立 console 与游戏进程不共享供应商限额，真实服务容量仍需验证。清空／静音通过语音队列代际阻止迟到解说和问答进入播放器。

## 4. Rust 引擎 Runner 协议

### 4.1 帧格式

stdin／stdout 为 UTF-8 JSON Lines，一行一个完整帧；stdout 不允许日志，stderr 只记录脱敏诊断。v1 初始帧上限 1 MiB，一次只执行一个状态修改或 decide 请求。批量 replay 超限时分块，不能写半行等待下次补完。

```json
{
  "v": 1,
  "id": "rpc-example",
  "runnerEpoch": "runner-instance-example",
  "method": "decide",
  "scope": { "handId": "hand-example", "decisionId": "decision-example" },
  "params": {
    "expectedCursor": 38,
    "stateVersion": 42,
    "snapshotHash": "sha256:example"
  }
}
```

示例 hash 仅展示字段；实现使用规范快照编码的实际 SHA-256。runnerEpoch 由主程序在每次启动子进程时生成，每个请求和响应都必须匹配。id 是 RPC 关联号，不能代替业务 decisionId。

成功响应为 `{v,id,runnerEpoch,scope,ok:true,result}`；失败为 `{v,id,runnerEpoch,scope,ok:false,error:PortError}`。两者互斥。不认识协议版本、畸形 JSON、超大帧时停止该连接，当前 provider 标记不可用，不能跳过帧继续假装状态一致。

### 4.2 方法与状态

| method | params | result／语义 |
| --- | --- | --- |
| `init` | 预配置模型标识、源码／模型摘要期望值、protocolVersion | 实际 engineVersion、modelHash、支持规则／分析能力；不接受外部任意路径 |
| `reset` | handId、ownSeat、已验证规则、reason | 初始化本小局空状态，cursor=0；reason 为 new-hand／recovery |
| `replay` | expectedCursor、按序事件数组 | 新 cursor、lastEventDigest；只用于恢复状态，禁止输出可执行副作用 |
| `advance` | expectedCursor、按序事件数组 | 同上；只输入已提交的游戏事实 |
| `decide` | expectedCursor、stateVersion、snapshotHash | 完整建议、可选偏好／分析指标、关联游标、版本、原请求快照关联 |
| `shutdown` | reason | 退出前确认；超时后由主管进程终止 |

每个事件项为 `{index, sourceEventId, mjai}`，index 从当前 cursor+1 连续增加。mjai 的实际字段按固定上游版本契约转换并验证；不在本文件发明未验证的 mjai 动作码。重复范围且内容摘要一致时返回已有游标；游标相同但内容不同、缺口或乱序返回 `ENGINE_CURSOR_MISMATCH`。

建议由 runner 归一化为完整 `EngineAdvice`：动作种类、牌编码、消耗牌、来源座位、杠类型及立直绑定弃牌中适用的字段。缺少首选动作必需参数时返回 `INCOMPLETE_ENGINE_ACTION`。EngineAdapter 将建议映射为当前唯一合法 actionId；无法唯一映射时拒绝，不能用未经补全的 top 3 列表执行。

```ts
type EngineAdvice =
  | { kind: 'discard'; tile: TileCode; tsumogiri: boolean }
  | { kind: 'riichi'; discardTile: TileCode; tsumogiri: boolean }
  | { kind: 'chi' | 'pon' | 'open-kan'; fromSeat: Seat;
      calledTile: TileCode; consumed: TileCode[] }
  | { kind: 'closed-kan'; tiles: TileCode[] }
  | { kind: 'added-kan'; existingPon: TileCode[]; addedTile: TileCode }
  | { kind: 'pass' };

interface EngineDecision {
  cursor: number;
  stateVersion: number;
  snapshotHash: string;
  advice: EngineAdvice;
  preferences?: { advice: EngineAdvice; value: number;
    unit: 'logit' | 'policy-weight' }[];
  analysis?: DecisionEvidence[];
  engineVersion: string;
  modelHash: string;
}
```

数组长度与牌组合按动作类型校验。此 runner v1 不提出 tsumo／ron，和牌由已验证的客户端自动功能拥有；特殊动作只有新增已验证映射和契约版本后才交给引擎，否则交由当前合法集合的降级规则或暂停处理。analysis 只包含上游确实提供的独立指标，其 actionId 在完成候选映射后才能关联。

游标和 snapshotHash 回传用于请求关联，不代表 runner 独立证明了雀魂状态完全一致；转换正确性需要回放对照。引擎建议也不推进权威局面，下一次 advance 仍以真实游戏事件为准。

调用端等待超时后废弃结果。若无法证明引擎内部游标及可变状态未受影响，终止 runner 并 reset＋replay 后再用；不在旧 RPC 尚未完成时并发发送新的决定。stdin 关闭时 runner 退出。旧 runnerEpoch 的响应无论内容如何都被丢弃。

## 5. 弹幕、内容与语音接口

### 5.1 BiliPort 与统一发送出口

| 方法 | 输入 | 输出／事件 |
| --- | --- | --- |
| `connect` | roomId、credentialProfileId、取消信号 | 连接状态、已验证账号身份、源能力 |
| `messages` | 当前连接代际 | 逐条 `IncomingViewerMessage`，断线／缺口事件 |
| `send` | `ApprovedReply` | `SendReceipt`；仅由 BiliGateway 调用 |
| `disconnect` | reason | 停止当前房间消费与发送，不退出用户账号 |

`IncomingViewerMessage` 包含 source、roomId、sourceMessageId（有则填）、源观众标识、displayName、text、sourceAt（有则填）、receivedAt。这个临时对象不直接持久化；先去重、自发消息识别和过滤，再形成模型中的 ViewerMessage。

`ApprovedReply = { deliveryId, contentId, roomId, connectionEpoch, text, moderationRevision, expiresAt, dryRun }`。Gateway 在发送前重新加载当前规则、房间、账号和预演状态；它不能仅凭调用者传来的 dryRun=false 绕过当前全局预演。

`SendReceipt = { deliveryId, status, observedAt, externalReceipt?, error? }`，status 为 simulated／published／blocked／expired／uncertain／failed。模拟发送单独记录为 simulated，不能计入真实 published 数；底层方法发送前先保存交付状态。迟到回执只更新对应 deliveryId，不能让旧房间内容再次发送。

源端发送超时若不能证明未接受，返回 uncertain；只有明确未发送、规则／房间仍匹配且未过期时，Gateway 才可按节流计划重试同一 deliveryId。自己发出的消息通过已验证账号身份与有限回声缓存排除，不靠显示名匹配。

当前支持直连 BilibiliDirect 和[本机转发器契约](../USAGE.md#b-站本机转发器契约)。`BiliPort.mode` 为 simulated／relay／direct；可选 status 提供连接、实际房间、账号、收取数、跳过数、缺口和脱敏错误码，disconnect 撤销当前连接。预演与出站共用交付入口，转发器的发送账号必须与入站身份同域。

直连先读取本机私有 Cookie 文件，通过 nav 验证账号，room_init 解析实际房号，签名后从 getDanmuInfo 获取允许域名的 WSS 地址与短期认证参数。只在 op=8 且 code=0 后标记 connected；每 30 秒发心跳，90 秒无回执断开。报文支持 v0／v1 与 zlib／Brotli 批次，限制单帧大小、解压总量、递归深度和待解码数量。消息环最多 256 条，每次 read 最多 50 条，游标缺失、重连或溢出显式标记 gap。只接受带源 id_str、稳定 uid 和源时间的 DANMU_MSG，隐私隐藏身份不猜测补全。认证失败／访问拒绝不切换旧接口绕过。

直连发送前重新验证账号，仅发一个 POST；在 SQLite 交付记录已占用后才进入发送，平台 code=0 且带 id_str 才返回 published。没有可确认消息 ID 时保持 uncertain；收到明确拒绝映射 failed。断线／换房撤销旧连接与旧发送许可，旧连接回调不能污染新房间。

### 5.2 ModerationPort 与内容发布

`evaluate({text, displayName?, channel, contextRef}, revision)` 返回：

```ts
type ModerationResult =
  | { disposition: 'allow' | 'replace'; text: string; displayName?: string;
      revision: number; matchedRuleIds: string[] }
  | { disposition: 'drop'; revision: number; matchedRuleIds: string[];
      reasonCode: string };
```

输入／用户名、档案、字幕、speech、bili-reply 都使用同一规则集合；channel 只能决定适用的长度与发布约束，不能默认绕过禁词。drop 结果不携带原文，原文不进入普通日志。

`publish(Content, channels)` 为每个渠道生成稳定 deliveryId。事实档案以 observedActionEventId 幂等更新；增强解释作为同一档案修订，不重复创建口播。字幕发布只表示服务投影更新，客户端是否显示由投影状态观察；它不等同于声音已播放或弹幕已发送。

### 5.3 TTS 与播放器

```ts
interface ApprovedSpeechText {
  speechId: string;
  contentIds: string[];
  text: string;
  voiceId: string;
  moderationRevision: number;
  queueEpoch: number;
  expiresAt: string;
}

interface AudioArtifact {
  artifactId: string;
  speechId: string;
  contentIds: string[];
  mediaType: 'audio/wav' | 'audio/aiff' | 'audio/mpeg';
  durationMs?: number;
  textDigest: string;
  moderationRevision: number;
  queueEpoch: number;
}

interface PlaybackRequest {
  artifactId: string;
  speechId: string;
  playbackEpoch: number;
  expiresAt: string;
}
```

`SpeechPort.synthesize(ApprovedSpeechText, signal)` 返回 AudioArtifact；`PlaybackPort.play(PlaybackRequest, signal)` 返回 `{speechId, playbackEpoch, outcome, startedAt?, finishedAt, error?}`，outcome 为 completed／cancelled／failed／uncertain。音频路径由 ArtifactStore 根据 artifactId 解析，不接受模型或观众传入任意本机路径。

合成完成先验证 queueEpoch、过期时间、内容仍被需要和当前禁词规则；播放前再次验证。只有播放器的真实结束才可记 speech published／completed。合成失败不影响文字档案；cancelled 不计入播完。

当前运行适配器为 `fishSpeech`：`SpeechPort.synthesize(text, voiceId, signal)` 调用 Fish `/v1/tts`，返回已验证非空的私有 MP3 路径，随后平台音频适配器播放、`release` 删除。Mac 使用 `afinfo`／`afplay`，Linux 使用 `ffprobe`／`ffplay`；共享进程执行器负责超时、取消和清理。请求和响应消费共用取消／30 秒超时信号，响应上限 8 MiB；保留已登记的中文心情标签，移除其他方括号指令。口播每句含标签和标点最多 19 字；`SpeechController` 仅负责音频播放，不触发弹幕发送。`Interaction` 仅在选中观众消息后独立发送一条简短回复，保留当前房间及账号校验、禁词、限长、冷却和持久去重。API 密钥仅从服务进程环境读取，不进入控制台配置与投影。`speech.provider` 当前为 `fish`，音色列表来自 `FISH_REFERENCE_ID`；旧 `macos` 配置启动时迁移并增加配置修订。实场 CLI 检测到完整 Fish 配置后自动启用，`--audio` 可显式要求音频。上方 artifact／播放回执结构仍是独立 ArtifactStore 的设计契约。

`stop({speechId, playbackEpoch})` 只停止所指播放实例，旧停止请求不能终止新的声音。`clearPending()` 增加 queueEpoch 并取消未播内容，保留当前播放许可；`setMuted(true)` 同时撤销 queueEpoch 与 playbackEpoch，停止当前播放。每个时刻只有一个播放器持有有效许可。

可选 `AvatarOutput.speech` 与本机播放器实现同一个运行时 `SpeechPort`，由 `--avatar` 或 `MAJI_AVATAR_ENABLED=true` 选择。浏览器回执绑定 speechId、playbackEpoch 与租约；其专用写通道不包含游戏控制。播放模式只在启动时装配，HTTP 形状见 [API §7.3](./API.md#73-live2d-角色播放)。

### 5.4 Live2D 角色输出（可选扩展）

当前实现为 `adapters/live/avatar-output.ts` 的 `AvatarOutput`、`soullink-motion.ts` 的动作规划器、`soullink-fish-voice.ts` 的 SDK 自定义语音 provider，以及 `app/console/avatar-*` 的浏览器页面。复用固定 npm 版本的 Soullink Emotion SDK；模型与 Core 使用本机资源，版本与来源见 [上游登记](../research/UPSTREAM.md)。此前 Open-LLM-VTuber／AIRI 方案保留为历史调研，不是当前运行依赖。

```ts
interface SpeechPlaybackContext {
  speechId: string;
  playbackEpoch: number;
  text: string; // 合并、过滤、短句化之后，保留心情标签
  expiresAt: string;
  onStarted(): void;
}
interface SpeechPort {
  readonly reportsStarted?: boolean;
  synthesize(text: string, voiceId: string, signal: AbortSignal): Promise<string>;
  play(artifact: string, signal: AbortSignal, context?: SpeechPlaybackContext): Promise<void>;
  release(artifact: string): Promise<void>;
}
```

`AvatarOutput` 包装已有合成与释放方法并提供 `speech`。`reportsStarted=true` 使 `SpeechController.playingSpeechId` 等待真实回执；准备阶段计入 pendingCount，不能显示成已经开播。SpeechController 继续拥有唯一队列、内容有效期、优先级和取消信号，角色适配器最多接受一条当前播放，不缓存后续口播。

`claim({rendererId,parameters})` 验证模型报告的参数边界并申请唯一租约。`poll(identity)` 续租并返回当前指令或 null，`ack` 处理准备／实际播放回执，`release` 撤销当前页面，`audio(identity,audioId)` 只读取当前实例的音频。方法签名及 HTTP DTO 以 [OpenAPI](./openapi.json) 的 Avatar schemas 为准；身份仅属于表现通道，不能提交游戏动作。

```ts
interface AvatarFrame {
  time: number; // 秒，相对同一音频实际起播时钟
  duration: number;
  label?: string;
  parameters: Record<string, number>;
}
interface AvatarCommand {
  speechId: string;
  playbackEpoch: number;
  phase: 'prepare' | 'play' | 'stop';
  audioUrl: string;
  text: string; // 展示正文，不带心情标签
  moods: string[];
  parameterPlan: AvatarFrame[];
  durationSec?: number;
}
```

播放依次经过以下阶段：

1. 只有已有有效渲染租约时才调用 Fish。合成完整 MP3 并完成格式校验后，控制器重新检查队列代际与有效期，将最终口播上下文交给角色输出。
2. prepare 令页面读取受租约保护的音频并用 AudioContext 解码；页面回报实际 durationSec，尚不发声。
3. `createSoullinkMotionPlanner` 将完整带心情台词、实际时长及最多 24 个已校准参数交给 SDK 的单阶段参数规划器，按整段音频请求 1–3 个稀疏关键帧，输出 token 上限 900。返回计划再次剔除未知参数与张嘴／下颌张开控制，并限制数值和时间范围。未配置、失败或超时返回空计划，页面继续使用本地情绪、待机与音频口型。
4. play 允许同一个 AudioBufferSource 开始发声。动作起点与采样分析共享 AudioContext.currentTime；客户端观察到运行时钟越过起点后回报 started，调用 onStarted。自然结束且先前已 started 才可完成 Promise；failed、cancelled、租约失效或时限到期均拒绝该次播放。
5. SpeechController 根据真实结果记录 completed／cancelled／failed，再释放 MP3。动作失败不会卡住麻将执行器；播放端整体失效也不会擅自同时切到系统播放器发声。

动作模型配置优先 `MAJI_LIVE2D_AI_*`，缺省沿用 `MAJI_AI_*`。模型地址、密钥与原始 provider 响应留在服务端；动作结果只包含已验证参数。规划请求默认 12 秒限制；角色适配器根据同一配置设置整体规划等待与准备时限，始终受当前语音有效期约束。`MAJI_LIVE2D_AI_RESPONSE_FORMAT` 可选择 none／json_object／json_schema，缺省沿用通用模型配置，没有设置时为 none；避免把服务不支持的结构化响应格式强加给供应商。

可选 `MAJI_LIVE2D_AI_REASONING_EFFORT` 为 none／minimal／low／medium／high，设置时才向兼容服务添加 reasoning_effort。该字段只影响角色动作请求，不修改生成口播正文的模型设置。控制台试听通过 `POST /api/avatar/test` 将服务端固定台词交给同一个 SpeechController，受播放端连接、空闲、静音及 30 秒冷却限制，不开放任意口播文本入口。

租约默认 4 秒，页面每 500 毫秒续约；客户端用单调时钟、扣除完整往返时间设置看门狗，并安排 WebAudio 原生停止点，JS 计时器被冻结仍会停止声音。停止已派发 play 的实例时保留 stop 指令，等待 cancelled／failed／ended 回执或租约到期，期间不能给另一页面播放权。启动角色服务在监听前等待 4.1 秒，避免旧进程仍有效的租约与新播放端重叠。结束后 command=null；重连及旧回执不能重播。对正在准备且尚无播放许可的实例可以直接取消，迟到的动作规划结果被丢弃。

`clearPending()` 取消所有未开始语音，包括浏览器 prepare，保留已实际 started 的当前句；`setMuted(true)` 同时停止当前音频、口型和动作，等待停止确认后才释放文件。故障播报抢占与招募取消沿用同一个信号。页面关闭／网络失败自行停播并释放；纯预览页不申请租约。

`loadAvatarAssets` 仅登记 `.model3.json` 中明确引用的运行时文件，拒绝离开模型目录的路径与符号链接；Profile 和 Core 单独登记为固定 URL。前端不接收任意本机路径。角色的实际绑定、Profile 与 OBS 音轨仍需对应资源的实测证据，接口测试不代表视觉质量验收。

## 6. 存储与可靠通知

StoragePort 是唯一写入 SQLite 的边界，事务请求是带类型的方法，不接受其他 worker 发送任意 SQL。核心方法如下：

| 方法 | 事务内保证 | 返回 |
| --- | --- | --- |
| `acceptCommand` | commandId 指纹检查、记录命令及必要控制变更 | 新记录或已有 CommandView |
| `updateCommand` | 版本化推进状态；终态不可被旧任务覆盖 | 最新 CommandView |
| `commitGameEvent` | 去重、分配 sequence、保存事件／状态、确认、outbox | committedSequence／stateVersion，或已提交结果 |
| `saveDecision` | 保存不可变快照、hash、结果与证据；不改旧快照 | decisionId 与记录版本 |
| `reserveAction` | 检查窗口槽位与期望版本、保存 prepared 尝试 | 原尝试或新尝试；冲突拒绝 |
| `markDispatching` | 写发送意图与步骤记录，持久化成功后才允许发出 | durable receipt |
| `confirmAction` | 匹配权威事实，写确认与决策状态、outbox | 确认记录；重复调用返回原结果 |
| `consumeFact` | 写弃牌事实模板／去重记录，同时推进 consumer offset | 内容 ID 与最新消费游标 |
| `updateDelivery` | 发布状态与修订校验，防止迟到回执覆盖新代际 | 每渠道真实状态 |
| `patchConfig` | expectedRevision 校验、原子更新配置；运行模式保留，场数／时长限额已移除 | 新 revision 和应用效果 |
| `retain` | 按引用保护活动／未决记录，清理超期数据与音频元数据 | 清理摘要，不含原始内容 |

上述调用的 expected 版本与数据库实际记录不符返回 `VERSION_CONFLICT`；调用者刷新状态后重新决定。存储 worker 不自行重新执行失败的副作用。操作先写意图再发送，发送后确认另一个事务，不能声称数据库事务覆盖了远端游戏。

迁移 003 将己方弃牌模板与 outbox 在同一 SQLite 事务写入，并从旧 outbox 补建。语音工作与回发在事务外推进。

迁移 004 在原弃牌档案增加 commentary。`readCommentaryContext` 返回已确认动作、关联的冻结决策及允许模板；`saveCommentary` 在事务内重新计算 contextHash、验证模板和证据集合，幂等保存同一档案的增强结果。晚到的动作确认使旧上下文失效，旧请求不能覆盖新决策证据；历史问答不改写原口播档案。

outbox 通知为 `{outboxId, eventId, sequence, type, scope, occurredAt, payload}`，payload 为已提交且脱敏的领域事实。消费是至少一次；消费游标、模板和幂等记录在同一事务中提交。语音、TTS、模型请求、弹幕发送均在事务外，根据持久化任务／交付记录启动。

存储超时但事务结果未知时，按事务请求 ID 查询，不能换 ID 重做动作认领或新增内容。关键持久化失败关闭游戏执行；普通指标可丢弃并计数，游戏事件不可静默丢弃。

## 7. Worker 消息协议

Worker 使用 MessagePort，协议独立于 HTTP 与 runner RPC：

```ts
type WorkerMessage =
  | { v: 1; kind: 'request'; id: string; workerEpoch: string;
      method: string; context: TaskContext; payload: unknown }
  | { v: 1; kind: 'response'; id: string; workerEpoch: string;
      ok: true; result: unknown }
  | { v: 1; kind: 'response'; id: string; workerEpoch: string;
      ok: false; error: PortError }
  | { v: 1; kind: 'cancel'; id: string; workerEpoch: string; reason: string }
  | { v: 1; kind: 'event'; workerEpoch: string; eventId: string;
      type: string; payload: unknown };
```

unknown 只表示传输层尚未解析；接收端按 worker 类型＋method／type 的静态白名单选择严格 schema，校验后才进入业务方法。不能作为任意函数调用总线。

| Worker | 允许的请求 | 事件／回调 | 溢出策略 |
| --- | --- | --- | --- |
| storage | 上节事务方法、受限查询与 outbox 拉取 | commit／故障通知 | 关键写入拒绝并关闸；不丢游戏事实 |
| local-rule | rankCandidates、cancel | 规则结果与耗时 | 返回 busy／超时，不积压过期决策 |
| live | consumeOutbox、configChanged、setMuted、clearPending、shutdown | modelRequest、内容／交付／模块状态更新 | 归档事实留在 outbox，过期互动与普通讲解任务可淘汰／合并 |

同一个 workerEpoch 下 id 唯一；worker 重启换 epoch 并清理待解析 Promise。主程序拒绝旧 epoch 的任何响应。取消有回执也不代表外部服务已取消；原任务后续 response 只归档诊断，不产生新动作。

主程序只接收 live 发出的已定义 modelRequest，并通过 ModelBroker 受限调度；live 没有 GamePort.execute 的方法能力。每个通道有消息大小与队列容量配置；没有配置／验证前不允许无限缓冲。

## 8. 必须联调的契约场景

- GameObservation 与持久化事件分配分开；源端重复／缺失与本地事件序号不能混淆。
- 暂停和新游戏消息在发送意图落库期间到来，最终发送点拒绝旧许可；已发出的动作保留未决。
- 多步骤动作保存每一步，后续只能基于预期权威转换续做，不能整体重发。
- runner 初始化、分块重放、重复块、游标冲突、超时、旧 runnerEpoch 和不完整立直建议分别验证。
- Worker 重启与迟到消息不能覆盖新任务；storage 超时未知时查询原事务。
- 旧小局解释、旧房间弹幕、禁词更新后的音频都需在最终发布点重新检查。
- clearPending 保留当前句完成回执，mute 撤销当前句；模拟弹幕发送与真实发布分别统计。
- outbox 重放补齐文字但不重复播音／发弹幕；回放装配没有真实副作用能力。

具体客户端协议字段、mjai 方言和 B站回执由技术验证补证据并固定版本；本文件约束适配器必须提供的语义，不能用未知上游字段填造一个看似完整的响应。

## 9. 常驻直播装配（已实现）

控制台的进程生命周期、对局监控、房间恢复和音视频输出分为以下模块；平台差异留在适配器内：

| 模块 | 职责与边界 |
| --- | --- |
| `app/console/automation.ts` | `AutomationPort.start()`／`stop()`／`refresh()`／`close()`；监护独立进程组，保留人工停止意图，启动不接受运行限额 |
| `app/console/automation-loop.ts` | 通用连续对局循环、招募、观察分片与故障重试；ego／Chromium 共用，`automation-ego.ts` 仅保留兼容重导出 |
| `app/console/automation-monitor.ts` | 进展监测、错误分类、1–60 秒退避；不执行游戏动作 |
| `app/console/room-recovery.ts` | 旧执行器退出后刷新桥接、验证旧房、处理结束与离房；随后由 `room-lifecycle.ts` 建房和招募 |
| `ports/browser.ts` | 平台无关的 `BrowserPagePort`；原 `EgoPagePort` 作为兼容别名保留，通用浏览器适配器不依赖雀魂传输实现 |
| `adapters/browser/chromium.ts` | Linux Chromium 的页面与 CDP 连接，使用 loopback `--browser-endpoint` |
| `app/console/relay.ts` | 自动开启、人工停止、画面健康检查与 2–60 秒退避；采集实现通过工厂注入 |
| `app/console/health-announcements.ts` | 故障事件去重、按来源每分钟节流、固定语音提示，不调用 LLM |
| `adapters/live/system-audio.ts` | Mac／Linux 音频验证和播放；进程取消、超时、退出确认 |

`AutomationView` 的基础字段为 `available / enabled / status / completedMatches / sessionId`，可选字段为 `roomId / recruitUntil / errorCode / recoveryCount / lastErrorCode / lastErrorAt / nextRetryAt / heartbeatAt / lastProgressAt`。工作进程每两秒发布心跳；父进程每两秒检查，30 秒无心跳即终止旧进程组。普通阶段超过 120 秒无推进、playing／recovering 超过 180 秒无进展、招募截止后超过 180 秒仍不推进，也触发监护恢复。单次对局内部每五秒读取权威步骤、手牌摘要和结束状态，读取超过 15 秒或连续 120 秒没有变化会取消该执行器。

取消后必须等旧工作排空并退出，不能并行创建新的动作执行器。恢复刷新桥接废除旧许可，`abandonOwnedRoom` 重新验证房主、四人友人房、房间身份和执行器许可；需要结束旧对局时发送一次终止请求并读回 `playing=false`，再离房和重新创建。未决动作和原始报告保留在共享台账；新的对局使用新会话，不重发旧动作或改写其确认状态。观察时限正常分片且闭合核验通过时继续同一对局，不执行房间重建。

可恢复故障持续退避；人工接管、登录失效、客户端／协议不匹配、房主不成立、终止或离房被拒绝、页面歧义与无效参数进入 `faulted`，等待人工处理后重新启用。浏览器连接关闭可由监护器创建新连接；ego 适配器不调用 claim／takeOver 抢回控制。`stop()` 先写入共享停止标记并取消监护，排空超时后结束旧进程组，不能由故障重试重新开启。

浏览器桥接版本为 5，`read()` 增加 `lobbyAuthenticated` 标志。大厅尚未认证且画面无法识别为已登录界面时，等待 90 秒后报告 `LOGIN_REQUIRED`，期间不刷新以免中断登录或验证。已认证但画面异常最多尝试两次刷新，每次完成后更新 `lastProgressAt`；Chromium 刷新期间连接关闭会立即报错，不以旧文档继续执行。

`SpeechContent.priority` 增加 `system`。错误提示优先于 viewer／discard／recruitment，取消旧解说的合成与播放后播报；手动 mute 仍会阻止所有声音。`HealthAnnouncements` 依据 `lastErrorAt`、`recoveryCount` 和错误码识别新故障，恢复历史字段持续保留不会导致每次轮询重复播报。合成与播放失败只记录失败和字幕，不改变故障恢复的进度。

`ConsoleRuntime` 首次实场 tick 自动启动转播，`relay.set` 的人工启停偏好持久保存。`RelayView.enabled` 表示用户启用意图，`recovering` 期间仍为 true；采集退出、30 秒没有首帧或 45 秒无新帧会关闭旧采集后重试。人工停止后 `enabled=false`，不再启动重试。Linux 与 ego 共用只监听 loopback 的 MJPEG 服务；OBS 字幕与游戏画面分别输出，声音由部署机器上的音频设备和推流器采集。

配置的 `run` 仅保留 `defaultMode`；加载旧持久配置时删除 `maxMatches / maxDurationMs` 并增加配置修订。回放保留人工暂停和本场后停止，实场持续运行直到人工停止或需要人工处理的故障。Debian 用 systemd 处理整个程序和浏览器意外退出，服务装配、登录与音轨见[部署说明](../DEPLOY_DEBIAN.md)。
