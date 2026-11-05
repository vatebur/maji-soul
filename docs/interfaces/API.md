# HTTP 与事件流接口

[文档导航](../README.md) · 接口

契约版本：v1，设计日期：2026-11-05（Asia/Shanghai）。状态：待实现。本文件依据 [需求](../planning/PLAN.md)、[模型](../design/DOMAIN_MODEL.md) 和 [架构](../design/ARCHITECTURE.md)，定义本机控制台与 OBS 使用的接口。字段与路径的机器可读定义见 [openapi.json](./openapi.json)，模块、Worker 和 Rust runner 的通信见 [INTERNAL_INTERFACES.md](./INTERNAL_INTERFACES.md)。

本轮 [Live2D 接入设计](../research/LIVE2D.md) 是可选扩展：当前 v1 不含角色配置、模型／音频资源读取、播放租约和浏览器回执接口。启用前须补齐专用身份、租约续约／撤销、失联停播、代际校验、回执去重和错误契约；HTTP 部分同步 OpenAPI，WebSocket 部分另有严格消息 schema。现有 `/obs` 与 OBS SSE 继续只读，控制台凭证不交给角色播放页面。

## 目录

- [1. 基本约定](#1-基本约定)
- [2. 本机身份与权限](#2-本机身份与权限)
- [3. 命令、幂等与并发](#3-命令幂等与并发)
- [4. 运行控制接口](#4-运行控制接口)
- [5. 查询与配置接口](#5-查询与配置接口)
- [6. 语音控制](#6-语音控制)
- [7. OBS 与 SSE](#7-obs-与-sse)
- [8. 错误与重试](#8-错误与重试)
- [9. 契约验证要求](#9-契约验证要求)

## 1. 基本约定

- 服务只绑定 loopback；文档示例地址为 `http://127.0.0.1:17361`，端口是本次设计默认值，可由本机配置修改。
- 路径沿用 `/api/...`；v1 通过响应的 `apiVersion: 1` 标识。破坏性修改引入新主版本路径；不静默改变既有字段含义。
- JSON 使用 UTF-8、camelCase；时间为 UTC ISO 8601，时长使用毫秒。界面负责转换 Asia/Shanghai 显示。
- ID 为不透明字符串，调用者不得从 ID 推导座位、小局或时间。整数版本非负；座位固定为绝对座位 `0..3`。
- 可选字段省略表示“不适用／尚未产生”；明确允许的 `null` 表示“当前没有”。无法确认的游戏信息使用 `{ "known": false, "reason": "..." }`，不以 `0` 代替未知。
- 请求拒绝未知字段，防止拼错配置时被静默忽略；客户端应忽略同主版本响应新增的可选字段。
- JSON 请求体设计上限 256 KiB；超限返回 `413`。快照响应、SSE 单帧和内部重放有独立边界。
- 所有动态响应使用 `Cache-Control: no-store`。接口不接收任意 shell 命令、原始游戏协议参数或任意 URL 请求任务。

普通 JSON 响应统一包装；`requestId` 只用于这一次 HTTP 请求，重试时变化：

```json
{
  "apiVersion": 1,
  "requestId": "req-example",
  "at": "2026-11-05T10:00:00.000Z",
  "data": { "status": "alive", "buildVersion": "design" }
}
```

错误响应使用相同的元信息，将 `data` 换为 `error`，二者不能同时存在。健康检查、HTML 页面、SSE 和 `204` 响应按各自定义处理。

## 2. 本机身份与权限

控制台使用本机会话 Cookie；OBS 只访问无需控制身份的精简只读投影。

| 接口 | 身份 | 请求与结果 |
| --- | --- | --- |
| `POST /api/auth/session` | 一次性启动令牌 | `{bootstrapToken}`；`200` 返回 `csrfToken / expiresAt` 并设置 Cookie |
| `GET /api/auth/session` | 控制台 Cookie | `200` 返回当前 `csrfToken / expiresAt`，用于页面刷新后的会话恢复 |
| `DELETE /api/auth/session` | Cookie＋CSRF | 注销，清除 Cookie，`204`；重复注销无额外副作用 |
| `GET /healthz` | 无 | `200` 表示 HTTP 主进程可响应，不代表游戏已就绪 |
| `GET /obs`、`GET /api/obs/*` | 无，只读 | 仅输出已过滤的播出内容，不下发控制凭证 |
| 其他 `/api/*` | 控制台 Cookie | 业务写请求还要求 `X-CSRF-Token` |

启动链接把短期令牌放在 URL fragment，页面交换后立即移除 fragment；令牌不进入查询参数、访问日志和 OBS 地址。令牌默认 60 秒有效且只可消费一次；会话默认 12 小时有效，主进程重启失效。两项都是本机身份设计参数，不是游戏规则。

Cookie 名为 `maji_console`，使用 `HttpOnly; SameSite=Strict; Path=/api`；本机 HTTP 不宣称启用了 HTTPS 的 Secure 属性。登录和写请求检查规范的本机 Origin；不开放跨域 CORS。CLI 在本机调用同一应用命令入口，不通过另一个匿名 HTTP 写接口绕过状态机。

## 3. 命令、幂等与并发

### 3.1 业务写请求

除身份建立／注销外，所有业务写请求必须包含：

| 字段 | 约束 | 含义 |
| --- | --- | --- |
| `commandId` | 全局唯一字符串，最长 128 字符 | 一次用户意图的幂等标识，调用者生成；重试必须复用 |
| `issuedAt` | UTC 时间 | 首次创建意图的时间；重试不得改为当前时间 |
| `sessionId` | 需要时为当前运行 ID；配置／语音允许 `null` | 防止旧页面控制已经更换的运行；与实际活动 session 不符返回 `SESSION_MISMATCH` |
| `expectedControlEpoch` | 恢复、结束、模式切换必填 | 乐观校验控制代际，冲突后刷新快照并创建新意图 |
| `expectedRevision` | 配置修改必填 | 只在对应配置版本上应用补丁 |

服务先查已持久化的 commandId，再检查时效和业务前提。相同 ID、相同 method／path／规范化请求体返回已有命令的**当前状态**；相同 ID 携带不同请求返回 `409 IDEMPOTENCY_CONFLICT`。指纹包含 `issuedAt`、版本和 sessionId，忽略 JSON 对象键顺序，保留数组顺序。

第一次收到的命令只接受过去 5 分钟以内、最多超前 30 秒的 `issuedAt`。命令记录至少保留 7 天，未决命令保留至对账完成；记录被清理后，原请求也因时间过期而不能重新执行。客户端不得重复使用旧 ID 构造新意图。

HTTP 重试不等于重发游戏动作。执行器仍使用小局／窗口提交槽位；同一命令即使经历重连、重新登录或进程恢复，也不能创建第二次模糊结果的外部提交。

### 3.2 命令查询与完成状态

业务写接口和 `GET /api/commands/{commandId}` 的 `data` 均为 `CommandView`：

```json
{
  "commandId": "cmd-resume-example",
  "name": "control.resume",
  "sessionId": "session-example",
  "status": "waiting-sync",
  "acceptedAt": "2026-11-05T10:00:00.000Z",
  "updatedAt": "2026-11-05T10:00:00.050Z"
}
```

| 状态 | 含义 | 调用者行为 |
| --- | --- | --- |
| `accepted` | 已持久化接收，还未开始处理 | 等待事件或查询 |
| `running` | 正在执行本机流程 | 等待；不要换 ID 重发 |
| `waiting-sync` | 闸门关闭，等待权威同步 | 展示同步中 |
| `uncertain` | 外部副作用结果无法确定 | 保持查询／对账，不自动重试外部动作 |
| `succeeded` | 达到该命令定义的完成条件 | 读取对应 `result` |
| `failed` | 已确定失败，附 `error` | 按错误策略处理 |
| `cancelled` | 被暂停、结束或更新的控制代际废弃 | 不恢复旧命令 |

初次写请求在尚未完成时返回 `202`，同步完成或重试命中终态时返回 `200`；命令查询始终以 `200` 返回找到的记录。接受后的失败保存在 `CommandView.error`，不把查询改成 HTTP 500。接收前的校验失败返回 HTTP 错误且没有 accepted 记录。

终态为 succeeded／failed／cancelled，才带 `completedAt`。uncertain 不是终态，可经对账转为 succeeded／failed。`202` 不能表示游戏已开局、自动和牌已关闭或音频已停止。

## 4. 运行控制接口

请求字段均加上 `commandId / issuedAt`；表中列出额外字段。

| 接口 | 额外请求字段 | 前置条件 | succeeded 的含义 |
| --- | --- | --- | --- |
| `POST /api/control/start` | `expectedConfigRevision` | 无活动运行、无尚未处理的恢复记录，配置版本匹配 | 环境／房间规则验证通过，首个整场已收到权威开始事件；返回新 sessionId |
| `POST /api/control/pause` | `sessionId`、可选 `reason`（≤200 字符） | 当前 session 匹配 | 程序动作闸门已关闭，任务代际失效；客户端自动和牌关闭情况另列 |
| `POST /api/control/resume` | `sessionId, expectedControlEpoch` | 当前运行 paused，控制代际匹配 | 权威同步、未决操作对账与状态验证通过，恢复 running 或 stopping |
| `POST /api/control/stop-after-match` | `sessionId` | 当前 session 匹配 | 停止意图已锁存；当前无整场时立即进入 stopped |
| `POST /api/control/next-mode` | `sessionId, expectedControlEpoch, mode` | 运行未结束；mode 为 engine／llm | pendingMode 已变更；activeMode 在下一次 HandStarted 才变更 |
| `POST /api/control/end` | `sessionId, expectedControlEpoch` | 当前运行 paused 或 faulted；stopped 可幂等返回 | 当前程序运行结束，未决尝试保留；不解散房间、不宣称服务器牌局结束 |

pause 与 stop-after-match 不要求调用者提供旧控制代际，以便立即关闸或锁存停止意图；仍校验 sessionId。已经 paused 时再次暂停无新副作用。start 不隐式恢复崩溃前的运行；应读取恢复中的 session，再明确 resume。

暂停成功结果示例，`clientMayAct` 明确客户端自身的自动操作是否仍可能发生：

```json
{
  "kind": "run-control",
  "sessionId": "session-example",
  "status": "paused",
  "controlEpoch": 8,
  "stopAfterMatch": false,
  "clientAutoWin": "verified-off",
  "clientMayAct": false,
  "warnings": []
}
```

未证实自动和牌关闭时，pause 仍可完成程序关闸，结果使用 `clientMayAct: true` 并列出警告。存储故障时也必须先在内存关闸，但响应为 `503 STORAGE_UNAVAILABLE`，`error.effect` 标明已关闸；不能声称命令已可靠持久化。

stop-after-match 成功仅表示意图生效，不表示整场已打完。暂停中的运行保持暂停；此命令不代替 resume。降低限额达到阈值后，增大限额也不自动撤销已锁存停止意图。

next-mode 请求示例：

```json
{
  "commandId": "cmd-mode-example",
  "issuedAt": "2026-11-05T10:00:00.000Z",
  "sessionId": "session-example",
  "expectedControlEpoch": 8,
  "mode": "llm"
}
```

它与 HandStarted 在同一 actor 队列排序：命令先提交则新小局采用新模式；HandStarted 先提交则该小局继续旧模式。结果带 `activeMode / pendingMode / currentHandId / effective: "next-hand"`。程序崩溃恢复到同一小局时保留 activeMode。

## 5. 查询与配置接口

| 接口 | 参数 | 返回 data |
| --- | --- | --- |
| `GET /api/console/snapshot` | 无 | `ConsoleSnapshot`，含投影游标和控制台状态 |
| `GET /api/commands/{commandId}` | 不透明命令 ID | `CommandView` |
| `GET /api/config` | 无 | `ConfigView`，包含 revision、可编辑值和只读能力状态 |
| `PATCH /api/config` | `commandId, issuedAt, sessionId, expectedRevision, changes` | `CommandView`，成功结果包含新 revision 与各组生效时点 |
| `GET /api/capabilities` | 无 | 可用中文声音、已配置模型 profile、TTS provider 和支持的游戏能力 |
| `GET /api/decisions` | `sessionId` 必填；可选 `matchId / handId / cursor / limit` | 决策摘要列表和 nextCursor |
| `GET /api/decisions/{decisionId}` | 决策 ID | 冻结记录、尝试、权威确认和解说 |

### 5.1 控制台快照

`ConsoleSnapshot = { projection, state }`。`projection` 包含 `epoch / revision / cursor / generatedAt`。state 字段为：

| 字段 | 含义 |
| --- | --- |
| `session` | 当前运行 ID、状态、controlEpoch、activeMode／pendingMode、原始开始时间、限额进度、停止意图；无运行时为 null |
| `room` | 房间 ID、流程状态、自动和牌验证结果及已验证规则；尚未取得房间时 null |
| `game` | 当前公共局面卡：matchId／handId、状态可信度与时间、场况、分数、宝牌、剩余牌、最近动作；无局面时 null |
| `modules` | 各模块 ready／degraded／unavailable／recovering 状态、错误码和更新时间 |
| `speech` | muted、queueEpoch、playbackEpoch、当前 speechId 与待播数量 |
| `interaction` | 房号、连接／身份状态、预演状态和待处理消息数量 |
| `configRevision` | 当前已提交配置版本 |
| `recentCommands` | 最近最多 20 条命令；更旧记录按 ID 查询 |

快照只显示最近可确认的事实；`game.trust` 与 `observedAt` 必须可见。对局结束后允许保留最后局面卡，同时标记 `handStatus: finished`，不能当成仍在进行的局面。

### 5.2 配置更新

changes 为显式定义的嵌套部分对象：省略保留原值，对象按字段合并，数组整体替换。除房号允许 null 表示断开外，null 不能删除配置。空 changes、未知键或无效组合返回 `422`。整份补丁在一个事务内应用或完全拒绝。

| 允许的配置组 | 首版字段 | 生效规则 |
| --- | --- | --- |
| `run` | defaultMode、maxMatches、maxDurationMs | 默认模式只影响新 session；限额同时更新所指活动 session 并立即检查阈值 |
| `persona` | name、style、catchphrases、teasingIntensity | 后续内容生成；不改历史事实 |
| `moderation` | rules（首版 literal 匹配，drop／replace） | 更新规则修订，所有待发布文字／音频重新检查 |
| `interaction` | roomId、globalIntervalMs、viewerCooldownMs、replyMaxChars、dryRun | 调度后续任务；发送前再检查；房号变化取消旧房间待发内容 |
| `speech` | provider、voiceId | 必须来自 capabilities；后续合成使用，新音色不重播旧内容 |
| `models` | decisionProfile、commentaryProfile | 选择已在本机配置的别名，不接收密钥、URL 或任意模型执行路径 |
| `output` | theme、showScores | 下一次展示投影生效 |
| `retention` | days | 后续清理使用；保护活动与未决记录 |

下小局模式通过 next-mode 命令控制，静音通过 mute 命令控制；它们不混入持久化默认值。游戏固定房型、协议版本、引擎文件、监听地址和凭证由本机配置提供，本 HTTP 配置接口只读显示其摘要。

有活动 session 时请求必须填写该 sessionId，无活动运行时填写 null；配置版本或活动 session 改变均返回冲突。房号更新成功表示配置提交和重连计划建立，实际连接结果从 modules／interaction 读取，失败不伪造已连接。

```json
{
  "commandId": "cmd-config-example",
  "issuedAt": "2026-11-05T10:00:00.000Z",
  "sessionId": "session-example",
  "expectedRevision": 12,
  "changes": {
    "interaction": { "globalIntervalMs": 5000, "viewerCooldownMs": 30000 },
    "persona": { "name": "麻将搭子", "teasingIntensity": "normal" }
  }
}
```

配置示例和字段范围见 OpenAPI。客户端按 capabilities 提供的 profile／声音 ID 选择，不把例子中的值当作当前机器已安装的声音或已配置的服务。

### 5.3 决策查询

列表默认 limit=20，最大 100，按创建顺序倒序；cursor 绑定查询过滤器与第一页的高水位，后续页不插入更新的决策。过滤器改变后必须重新开始。非法 cursor 返回 `422`，过期 cursor 返回 `410 CURSOR_EXPIRED`。

摘要包含 decisionId、matchId、handId、createdAt、activeMode、status、已采纳 provider／actionId（如有）与是否降级。详情返回 [DecisionRecord](../design/DOMAIN_MODEL.md) 和关联尝试、确认、解释，不把 provider 建议当作实际动作。详情允许读取自己的冻结手牌；OBS 投影不包含这些数据。

不存在的 ID 返回 `404`；仍有清理标记且已过保留期时可返回 `410 RECORD_EXPIRED`，不承诺永久保留所有被删 ID 的标记。

## 6. 语音控制

| 接口 | 请求字段（加 commandId／issuedAt） | 行为与完成条件 |
| --- | --- | --- |
| `POST /api/speech/mute` | `sessionId`（可 null）、`muted` | true 取消待播／在合成内容并停止当前声音；false 只允许后续有效内容进入播放 |
| `POST /api/speech/clear` | `sessionId`（可 null） | 取消待播／在合成内容，保留正在播放的当前句 |

clear 递增 `queueEpoch`，使旧合成结果无效；它不递增当前播放器的 `playbackEpoch`，因此当前句仍可正常确认结束。mute=true 同时撤销队列和当前播放代际。二者成功结果均包含当前 `muted / queueEpoch / playbackEpoch / cancelledCount / playingSpeechId`。

尚未证实声音停止时 mute 保持 running；播放器确认停止后才 succeeded。结果不明时 uncertain，并报告模块异常。已取消的任务不因解除静音重新入队。游戏暂停与语音静音各自独立。

## 7. OBS 与 SSE

### 7.1 OBS 投影

`GET /api/obs/snapshot` 返回 `{ projection, state }`；state 只包含 `runStatus / activeMode / pendingMode / game / subtitle / interaction / muted`。`subtitle` 和 `interaction` 是带 contentId、文本与时间的当前播出卡片，无内容时 null。game 使用与控制台一致的公共局面卡。

此 DTO 采用白名单构造，不能把控制台对象删几个字段后直接发送。它不含 controlEpoch、配置、完整手牌／候选、原始弹幕、凭证、音频文件绝对路径或控制令牌。首版 OBS 页面只展示；默认音频来自本机单播放器。

### 7.2 连接、游标与重连

| 接口 | 身份 | 首次续传参数 |
| --- | --- | --- |
| `GET /api/console/events` | Cookie | 可选 `after`，使用 console snapshot 的 cursor |
| `GET /api/obs/events` | 无，只读 | 可选 `after`，使用 obs snapshot 的 cursor |

响应为 `text/event-stream`。浏览器自动重连带 `Last-Event-ID` 时优先使用该头；否则使用 after。cursor 不透明且绑定 channel 与 projection epoch，console 游标不能用于 obs。

第一次获取快照后用其 cursor 订阅；服务从该游标之后补发事件。无 cursor、游标过期、epoch 改变或慢消费者造成缺口时，发送带**完整最新投影**的 reset，然后继续事件流。建立快照和登记订阅在同一投影边界完成，不能丢失二者之间的更新。

SSE 的 id 对应 payload 中 projection.cursor；同一个 epoch 内 revision 递增。客户端丢弃重复或倒退版本；reset 的新 epoch 会替换原投影。心跳是 `: ping` 注释行，不改变游标。鉴权失败在建立流前返回 HTTP 401；已连接会话到期时关闭流，由客户端重新建立身份。

| event | data 的结构 | 渠道 |
| --- | --- | --- |
| `snapshot` | 完整 `ConsoleSnapshot` 或 `ObsSnapshot` | 各自渠道 |
| `command` | `{ projection, command: CommandView }` | 仅控制台 |
| `reset` | 对应渠道的完整 snapshot | 各自渠道 |

SSE data 直接是上表 DTO，没有普通 HTTP 的 requestId 包装。例如：

```text
id: console.epoch-example.24
event: command
data: {"projection":{"epoch":"epoch-example","revision":24,"cursor":"console.epoch-example.24","generatedAt":"2026-11-05T10:00:00.000Z"},"command":{"commandId":"cmd-resume-example","name":"control.resume","sessionId":"session-example","status":"waiting-sync","acceptedAt":"2026-11-05T10:00:00.000Z","updatedAt":"2026-11-05T10:00:00.000Z"}}

```

投影序号与 `GameState.stateVersion` 不相同；语音、命令状态等也会推进投影。SSE 是有界的展示订阅，允许 reset 到最新快照；完整审计与历史决策读取持久化存储，不能依赖浏览器收到所有展示事件。客户端不得因 SSE 重放而重新发命令。

## 8. 错误与重试

```json
{
  "apiVersion": 1,
  "requestId": "req-conflict-example",
  "at": "2026-11-05T10:00:00.000Z",
  "error": {
    "code": "CONFIG_REVISION_MISMATCH",
    "message": "配置已更新，请刷新后重试",
    "effect": "none",
    "retry": "after-refresh",
    "details": { "currentRevision": 13 }
  }
}
```

`effect` 为 none／applied／unknown；`retry` 为 none／same-command／after-refresh／after-recovery。message 可展示但不能用于程序分支，分支只依赖 code。details 是白名单字段，不包含原始上游响应、认证信息或被屏蔽原文。

| HTTP | code | 处理 |
| --- | --- | --- |
| 400 | `INVALID_JSON` | 修正请求；没有执行 |
| 401 | `AUTH_REQUIRED`, `AUTH_EXPIRED`, `BOOTSTRAP_INVALID` | 重新建立本机身份 |
| 403 | `ORIGIN_FORBIDDEN`, `CSRF_INVALID` | 检查调用来源，不重试业务动作 |
| 404 | `NOT_FOUND` | 检查 ID；未知命令不等同于证明外部游戏未发生动作 |
| 409 | `IDEMPOTENCY_CONFLICT` | 不得用相同 ID 改请求 |
| 409 | `SESSION_MISMATCH`, `CONTROL_EPOCH_MISMATCH`, `CONFIG_REVISION_MISMATCH` | 刷新状态后，以新 ID 表达新的用户意图 |
| 409 | `INVALID_STATE`, `RECOVERY_REQUIRED` | 修复状态或先完成恢复；不可隐式新开运行 |
| 410 | `COMMAND_EXPIRED`, `CURSOR_EXPIRED`, `RECORD_EXPIRED` | 不重放旧命令；列表重新查询，历史记录可能不可恢复 |
| 413 | `PAYLOAD_TOO_LARGE` | 缩小输入 |
| 422 | `VALIDATION_FAILED`, `UNSUPPORTED_CAPABILITY` | 查看 fields／能力列表后修正 |
| 429 | `RATE_LIMITED` | 遵循 Retry-After，仍使用同一个 commandId |
| 503 | `STORAGE_UNAVAILABLE`, `SERVICE_UNAVAILABLE` | 先查询状态／恢复；若再提交，复用原 commandId |
| 500 | `INTERNAL_ERROR` | 保留 requestId，查询命令后处理，不能换 ID 盲重试 |

接受后的异步命令还可报告 `SYNC_INCOMPLETE / STATE_UNTRUSTED / ACTION_UNCERTAIN / DEADLINE_EXCEEDED / PROVIDER_UNAVAILABLE / PLAYBACK_UNCERTAIN / CANCELLED`。这些是 CommandView.error 的 code，不强行映射为查询接口的 HTTP 错误。

游戏动作提交、弹幕发送、音频播放各有自己的确认依据；通用 HTTP 重试策略不能替代它们。网络断开后先查询 commandId，无法查询时只重传原请求，不生成新的副作用意图。

## 9. 契约验证要求

实现阶段至少覆盖：请求字段／大小校验、同 ID 同请求与冲突请求、时效／保留清理、异步失败查询、旧 session／版本拒绝、暂停在存储失败时仍关闸、模式切换与 HandStarted 的先后顺序、配置事务和限额锁存、语音 clear／mute 的代际区别、SSE 快照订阅间隙与 reset、OBS 字段白名单。

OpenAPI 负责 HTTP 形状、示例和可导入定义；事件游标、外部动作确认和竞态等语义以本文件和 [内部接口](./INTERNAL_INTERFACES.md) 为准。所有文件随契约变更一起更新；当前文档未表示已有服务通过了这些验证。
