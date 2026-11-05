# 内部模块与进程接口

[文档导航](../README.md) · 接口

契约版本：v1，设计日期：2026-11-05。状态：目标设计，阶段 1 子集已实现。本文落实 [架构](../design/ARCHITECTURE.md) 中的 port、事件、Worker 和引擎进程边界；领域结构以 [DOMAIN_MODEL.md](../design/DOMAIN_MODEL.md) 为准，对外服务见 [API.md](./API.md)。这里定义的是本项目的接口，不声称上游已经提供这些方法或服务。

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
  mediaType: 'audio/wav' | 'audio/aiff';
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

`stop({speechId, playbackEpoch})` 只停止所指播放实例，旧停止请求不能终止新的声音。`clearPending()` 增加 queueEpoch 并取消未播内容，保留当前播放许可；`setMuted(true)` 同时撤销 queueEpoch 与 playbackEpoch，停止当前播放。每个时刻只有一个播放器持有有效许可。

预留 OBS 浏览器音频适配通过独立播放租约实现：started／ended／failed 回执绑定 speechId、artifactId、租约和 playbackEpoch。其专用写权限不包含游戏控制；首版默认本机播放，因此本轮 OpenAPI 不开放播放回执或音频下载接口，启用该适配时再补完整身份与租约契约。

### 5.4 Live2D 角色输出（可选扩展草案）

本节定义本项目的输出边界，不是 Open-LLM-VTuber 或 AIRI 已提供的外部 API。复用版本、源码差异与验收见 [LIVE2D.md](../research/LIVE2D.md)。以下类型在启用角色功能时落实为运行时 schema；当前不改变 v1 OpenAPI。

```ts
type AvatarExpression = 'neutral' | 'thinking' | 'joy' | 'surprise' | 'frustrated';
type AvatarMotion = 'idle' | 'talk' | 'greet' | 'celebrate';

interface AvatarProfile {
  profileId: string;
  modelRevision: number; // 资源或映射变更时递增，按 profileId 计数
  provider: 'open-llm-vtuber' | 'airi';
  upstreamCommit: string;
  modelAssetId: string;
  defaultExpressionId?: string; // 缺省则恢复模型初始参数
  expressionMap: Partial<Record<AvatarExpression, string>>;
  motionMap: Partial<Record<AvatarMotion, string>>;
}

interface AvatarReady {
  rendererId: string;
  rendererEpoch: string; // 每次页面／渲染上下文重建更换
  profileId: string;
  modelRevision: number;
  capabilities: {
    expressionIds: string[];
    motionIds: string[];
    lipSync: 'none' | 'volume' | 'phoneme';
  };
}

interface AvatarCue {
  v: 1;
  cueId: string;
  scope?: Scope;
  rendererEpoch: string;
  profileId: string;
  modelRevision: number;
  expiresAt: string;
  durationMs: number;
  trigger: { kind: 'immediate' }
    | { kind: 'speech'; speechId: string; playbackEpoch: number };
  expression?: AvatarExpression;
  motion?: AvatarMotion;
}

interface RendererPlaybackEvent {
  v: 1;
  eventId: string;
  rendererId: string;
  rendererEpoch: string;
  leaseId: string;
  speechId: string;
  artifactId: string;
  playbackEpoch: number;
  status: 'started' | 'ended' | 'cancelled' | 'failed';
  observedAt: string;
  errorCode?: string;
}
```

模型能力从实际资源与适配器确认；lipSync=phoneme 只表示该路径有相应驱动，不承诺每个模型或中文发音达到同等效果。映射值是适配器登记的资源 ID，不能接收未经登记的动作文件路径。上游某些路径只支持一个表情；本接口每条 cue 也最多一个表情与一个动作，不暗示上游能同时叠加任意表情。

| AvatarPort 方法 | 输入／结果 | 语义 |
| --- | --- | --- |
| `configure(profile, signal)` | AvatarProfile → AvatarReady | 验证资源、加载模型、报告能力；换模型前协调停止当前语音 |
| `cue(cue, signal)` | AvatarCue → cueId 与 accepted／expired／unsupported | 只确认受理，不表示声音已播放；speech 触发指令等待对应实际 started |
| `reset(target)` | rendererEpoch、profileId、modelRevision、reason | 对当前目标复位表情、口型和动作；旧目标请求不影响新模型 |
| `events(signal)` | 角色 ready／degraded／unavailable、cue 应用／取消／失败 | 只更新表现与健康，不授予游戏控制权 |
| `close(reason)` | 释放完成 | 停止该实例的表现并释放渲染资源 |

同 cueId 相同载荷幂等，改变载荷拒绝；cue 至少包含 expression 或 motion，durationMs 有上限。开始前核对 scope、时效与代际，超过 expiresAt 不再应用；应用后在 durationMs、expiresAt、绑定语音终止中最早发生的时点复位。表情应用与音频交付分别记录。

浏览器音频仍由 PlaybackPort 实现。适配器把内部 PlaybackRequest 包装为带 rendererEpoch／leaseId 的传输消息，ArtifactStore 提供仅限已登记音频的读取能力。RendererPlaybackEvent 在专用通道返回并映射成 PlaybackOutcome；正常 ended 才能 completed，failed／cancelled 不能伪装为正常播完，失联未知则 uncertain。

每个事件校验租约、speechId、artifactId 和两个播放相关代际，按 eventId 去重并检查状态转换；observedAt 由页面报告，服务端另记 receivedAt，不能依赖页面时间作授权。旧租约迟到的结束只可保留诊断，不能完成新任务；先前已判定取消／失败的任务不能被迟到 ended 改成成功。

租约必须有 expiresAt、续约、显式撤销和页面失联停播约束；接收旧命令不得续活租约。更换播放端前确认旧端停止，或等待租约到期且验证客户端看门狗确实停止；无法保证时继续语音降级，不并行开第二个声音。clear 仅清除未播放 cue／音频，保留当前句；mute、模型切换和播放端切换停止当前音频及其表现，解除后不重放旧句。

专用通道的身份建立、资源读取、租约与回执路由在 L2 前补齐；现有 OBS 只读 SSE 不用于回执写入。角色关闭后回到默认音频输出模式仍走同一个 SpeechController，不新增播报调度器。

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
| `patchConfig` | expectedRevision 校验、原子更新配置及运行限额 | 新 revision 和应用效果 |
| `retain` | 按引用保护活动／未决记录，清理超期数据与音频元数据 | 清理摘要，不含原始内容 |

上述调用的 expected 版本与数据库实际记录不符返回 `VERSION_CONFLICT`；调用者刷新状态后重新决定。存储 worker 不自行重新执行失败的副作用。操作先写意图再发送，发送后确认另一个事务，不能声称数据库事务覆盖了远端游戏。

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
