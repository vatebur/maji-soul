# HTTP 与事件流接口

[文档导航](../README.md) · 接口

契约版本：v1，更新日期：2026-11-13（Asia/Shanghai）。状态：回放、台账跟随、实场连续运行、故障监控和自动转播已实现，实场效果仍按验收记录确认。本文件依据 [需求](../planning/PLAN.md)、[模型](../design/DOMAIN_MODEL.md) 和 [架构](../design/ARCHITECTURE.md)，定义控制台与 OBS 使用的接口。字段与路径的机器可读定义见 [openapi.json](./openapi.json)，模块、Worker 和 Rust runner 的通信见 [INTERNAL_INTERFACES.md](./INTERNAL_INTERFACES.md)。

可选 Live2D 输出通过 `--avatar` 装配；[角色播放接口](#73-live2d-角色播放)单独处理配置、资源、唯一播放租约和浏览器回执。现有 `/obs` 与 OBS SSE 继续只读。历史选型与当前实施边界见 [Live2D 接入设计](../research/LIVE2D.md)。

当前装配通过 `npm start -- console` 启动。运行命令用于回放演练；普通台账跟随模式只读游戏事实，游戏运行控制命令返回 `UNSUPPORTED_CAPABILITY`。本机控制台提供同步命令完成结果、持久命令去重和快照流。真实游戏的开局／同步命令状态仍按下文目标契约验收。

模型解说通过 `models.commentaryProfile` 的 `disabled`／`local` 切换，`local` 只引用本机环境变量中已有的模型配置，未配置时返回 `UNSUPPORTED_CAPABILITY`。`GET /api/output/status` 的 `commentary` 返回 enabled、available、pendingCount、busy 和最近一次来源／脱敏错误码。`GET /api/discards` 同时返回 source、evidenceIds、limitations、createdAt，增强解释保持原档案 ID。模型故障不影响基础事实档案和字幕。思路生成最小间隔由 `models.commentaryIntervalMs` 设置，默认 15000 毫秒，范围 1000–300000 毫秒；保存后重新安排待处理生成，不中断正在生成的思路。

`GET /api/output/status` 的 `bilibili.mode` 为 unavailable／simulated／relay／direct。直连时同时返回 connection、roomId（解析后的实际房间）、accountId、receivedCount、droppedCount、gap、errorCode。账号已登录且弹幕认证成功才显示 connected，Cookie 与连接 token 不进入任何响应。`readOnly.bilibiliCredentialsConfigured` 表示当前装配具备真实来源配置，不等于已登录成功或已发送。真实回发仍受 interaction.dryRun 控制。

## 目录

- [1. 基本约定](#1-基本约定)
- [2. 控制台访问](#2-控制台访问)
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

## 2. 控制台访问

控制台无需登录；打开普通 `consoleUrl` 即可查询状态、订阅事件和提交控制命令。不设置会话 Cookie，不要求启动令牌或 `X-CSRF-Token`。原 `/api/auth/session` 接口已移除。

服务仍绑定本机回环地址。浏览器写请求检查同源 Origin，不开放跨域 CORS；本机 API 客户端可以不发送 Origin。OBS 继续输出精简只读投影。命令字段、幂等、状态机和游戏动作校验保持生效。

## 3. 命令、幂等与并发

### 3.1 业务写请求

所有业务写请求必须包含：

| 字段 | 约束 | 含义 |
| --- | --- | --- |
| `commandId` | 全局唯一字符串，最长 128 字符 | 一次用户意图的幂等标识，调用者生成；重试必须复用 |
| `issuedAt` | UTC 时间 | 首次创建意图的时间；重试不得改为当前时间 |
| `sessionId` | 需要时为当前运行 ID；配置／语音允许 `null` | 防止旧页面控制已经更换的运行；与实际活动 session 不符返回 `SESSION_MISMATCH` |
| `expectedControlEpoch` | 恢复、结束、模式切换必填 | 乐观校验控制代际，冲突后刷新快照并创建新意图 |
| `expectedRevision` | 配置修改必填 | 只在对应配置版本上应用补丁 |

服务先查已持久化的 commandId，再检查时效和业务前提。相同 ID、相同 method／path／规范化请求体返回已有命令的**当前状态**；相同 ID 携带不同请求返回 `409 IDEMPOTENCY_CONFLICT`。指纹包含 `issuedAt`、版本和 sessionId，忽略 JSON 对象键顺序，保留数组顺序。

第一次收到的命令只接受过去 5 分钟以内、最多超前 30 秒的 `issuedAt`。命令记录至少保留 7 天，未决命令保留至对账完成；记录被清理后，原请求也因时间过期而不能重新执行。客户端不得重复使用旧 ID 构造新意图。

HTTP 重试不等于重发游戏动作。执行器仍使用小局／窗口提交槽位；同一命令即使经历重连或进程恢复，也不能创建第二次模糊结果的外部提交。

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

stop-after-match 成功仅表示意图生效，不表示整场已打完。暂停中的运行保持暂停；此命令不代替 resume。运行没有自动场数／时长停止条件，人工停止意图不会因配置更新而撤销。

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
| `GET /api/discards` | 可选 `sessionId`，缺省为当前台账会话 | 最近 100 条己方弃牌事实文本、证据 ID 与已确认决策 ID |
| `GET /api/output/status` | 无 | 当前来源、最近一次语音完成结果和弹幕交付状态 |
| `GET /api/capabilities` | 无 | 可用中文声音、已配置模型 profile、TTS provider 和支持的游戏能力 |
| `GET /api/decisions` | `sessionId` 必填；可选 `matchId / handId / cursor / limit` | 决策摘要列表和 nextCursor |
| `GET /api/decisions/{decisionId}` | 决策 ID | 冻结记录、尝试、权威确认和解说 |

### 5.1 控制台快照

`ConsoleSnapshot = { projection, state }`。`projection` 包含 `epoch / revision / cursor / generatedAt`。state 字段为：

| 字段 | 含义 |
| --- | --- |
| `session` | 当前运行 ID、状态、controlEpoch、activeMode／pendingMode、原始开始时间、已完成场数、停止意图；无运行时为 null |
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
| `run` | defaultMode | 默认模式只影响新 session；不接受场数或时长上限 |
| `persona` | name、style、catchphrases、teasingIntensity | 后续内容生成；不改历史事实 |
| `moderation` | rules（首版 literal 匹配，drop／replace） | 更新规则修订，所有待发布文字／音频重新检查 |
| `interaction` | roomId、globalIntervalMs、viewerCooldownMs、replyMaxChars、dryRun | 调度后续任务；发送前再检查；房号变化取消旧房间待发内容 |
| `speech` | provider、voiceId | 必须来自 capabilities；后续合成使用，新音色不重播旧内容 |
| `models` | decisionProfile、commentaryProfile、commentaryIntervalMs | 选择已在本机配置的别名，不接收密钥、URL 或任意模型执行路径 |
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

当前语音提供方为 `fish`，`GET /api/capabilities` 的音色列表来自服务端 `FISH_REFERENCE_ID`。`--audio` 启用合成与本机播放，密钥不通过 HTTP 配置；不加入情绪提示。旧系统语音设置在控制台重启时自动迁移并递增配置修订，客户端应读取新的 revision。

| 接口 | 请求字段（加 commandId／issuedAt） | 行为与完成条件 |
| --- | --- | --- |
| `POST /api/speech/mute` | `sessionId`（可 null）、`muted` | true 取消待播／在合成内容并停止当前声音；false 只允许后续有效内容进入播放 |
| `POST /api/speech/clear` | `sessionId`（可 null） | 取消待播／在合成内容，保留正在播放的当前句 |

clear 递增 `queueEpoch`，使旧合成结果无效；它不递增当前播放器的 `playbackEpoch`，因此当前句仍可正常确认结束。mute=true 同时撤销队列和当前播放代际。二者成功结果均包含当前 `muted / queueEpoch / playbackEpoch / cancelledCount / playingSpeechId`。

尚未证实声音停止时 mute 保持 running；播放器确认停止后才 succeeded。结果不明时 uncertain，并报告模块异常。已取消的任务不因解除静音重新入队。游戏暂停与语音静音各自独立。

## 7. OBS 与 SSE

### 7.1 OBS 投影

`GET /api/obs/snapshot` 返回 `{ projection, state }`；state 只包含 `runStatus / activeMode / pendingMode / game / subtitle / interaction / muted / theme`。`subtitle` 和 `interaction` 是带 contentId、文本与时间的当前播出卡片，无内容时 null。game 使用与控制台一致的公共局面卡。

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

### 7.3 Live2D 角色播放

`GET /avatar` 是背景透明的角色浏览器源；`?debug=1` 显示配置／音频状态，`?preview=1` 只渲染模型、不申请播放权。页面使用本机服务中的受限资源 URL，不接收模型或观众指定的任意 URL。服务端的 Fish、LLM 密钥和资源原始路径不进入页面配置。

`/api/avatar/*` 使用专用的直接 JSON 对象，不套用控制台 `apiVersion/requestId/data` 成功响应封套，也不使用控制台 `commandId`。角色业务错误返回 `{error: "错误码"}`；通用 JSON 解析、请求大小与服务器错误仍可能使用 `ErrorEnvelope`。所有写请求必须携带与服务一致的 Origin；请求字段与枚举严格校验，播放身份只作用于角色音频通道。

| 接口 | 请求／响应 |
| --- | --- |
| `GET /api/avatar/config` | 返回 `enabled / modelConfigured / modelUrl / profileUrl / coreUrl / characterName`，资源缺省 URL 为 null；启用时另带 connected、plannerAvailable、phase、speaking、last |
| `POST /api/avatar/claim` | `{rendererId, parameters}`；parameters 为模型实际参数 ID 到 `{min,max,default,name?}` 的映射。返回 `leaseId / leaseMs / serverNow / expiresAt` |
| `POST /api/avatar/poll` | `{rendererId,leaseId}`；续租并返回租约时间及当前 `command`，无待处理指令时为 null |
| `POST /api/avatar/ack` | 租约身份及 `speechId / playbackEpoch / status`；status 为 ready／started／ended／cancelled／failed，ready 另带实际音频 `durationSec` |
| `POST /api/avatar/release` | `{rendererId,leaseId}`，释放当前页面的播放权并终止其未完成播放 |
| `POST /api/avatar/test` | 空对象 `{}`，当前渲染器已连接、语音空闲且未静音时，通过原队列播放固定试听台词；返回 `{ok:true,contentId}` |
| `GET /api/avatar/audio/{audioId}` | query 为 rendererId、leaseId；只返回当前实例的 MP3 字节，过期或取消后拒绝读取 |

试听台词固定为「[开心]大家好，一起开心打牌吧。」，不能提交自定义文本，也不发送弹幕或操作牌局。成功只表示入队，真实结果从 `GET /api/output/status` 读取。每次成功请求后冷却 30 秒；未连接返回 `409 AVATAR_RENDERER_UNAVAILABLE`，忙或静音返回 `409 AVATAR_SPEECH_BUSY_OR_MUTED`，冷却内返回 `429 AVATAR_TEST_COOLDOWN`。试听同样要求严格同源 Origin。

`GET /api/output/status` 在角色模式增加 `avatar`，其字段与上述播放状态相同。`/avatar-assets/model/...` 只开放模型清单与其显式引用的资源，Profile 和 Core 通过固定 URL 返回；目录中的其他文件、逃出模型目录的路径或符号链接不开放。`/avatar.bundle.js` 尚未构建时返回 `503 AVATAR_BUILD_REQUIRED`。

租约默认 4 秒，页面每 500 毫秒轮询；同一时刻只允许一个正式页面获得租约，第二个页面不能抢占。`serverNow / expiresAt` 为服务器时间毫秒，页面扣除请求往返耗时后使用单调时钟设置失联停播期限。网络失败、页面关闭或租约到期时停止音频、口型与动作；重新连接不能让已结束或撤销的语音复活。

每条指令绑定 `speechId / playbackEpoch`，包含 `phase`（prepare／play／stop）、`audioUrl / text / moods / parameterPlan` 和可选的 `durationSec`。音频 URL 仅授予当前租约和播放实例。prepare 只解码音频并回报 ready；完成动作规划后才发送 play。页面以同一个 AudioContext 播放音频、分析口型和推进动作，只有实际起播才回报 started，只有自然播完才回报 ended。失败与取消不能完成当前语音；旧身份、旧实例的回执不能推进新播放。

「清空待播」取消尚未实际开始的准备工作，维持已经 started 的当前播放；「静音」发出 stop，并等待页面确认或有效租约到期后释放音频。准备阶段尚无发声许可，可以直接取消。结束后的轮询返回 null，不按旧字幕或 SSE 历史快照再次触发动作；已结束实例的重复回执返回 `AVATAR_PLAYBACK_EXPIRED`，不会重新完成或重播。此通道不授予游戏操作权限，也不创建第二套口播队列。

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
| 403 | `ORIGIN_FORBIDDEN` | 检查调用来源，不重试业务动作 |
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

实现阶段至少覆盖：请求字段／大小校验、同 ID 同请求与冲突请求、时效／保留清理、异步失败查询、旧 session／版本拒绝、暂停在存储失败时仍关闸、模式切换与 HandStarted 的先后顺序、配置迁移和人工停止意图、语音 clear／mute 的代际区别、故障恢复及错误播报、SSE 快照订阅间隙与 reset、OBS 字段白名单。

OpenAPI 负责 HTTP 形状、示例和可导入定义；事件游标、外部动作确认和竞态等语义以本文件和 [内部接口](./INTERNAL_INTERFACES.md) 为准。所有文件随契约变更一起更新；当前文档未表示已有服务通过了这些验证。


## 实场自动出牌开关

通过 `--space --page --live-options`（ego）或 `--browser-endpoint --live-options`（Chromium）装配后，`POST /api/automation/set` 接受 `{commandId, issuedAt, sessionId, enabled}`。无需登录，沿用来源校验和命令去重；未装配时返回 `409 UNSUPPORTED_CAPABILITY`。成功响应表示启动或停止请求已交给执行器，实际进度由快照流更新。`--auto-start` 在服务启动后调用同一个启用入口。

`ConsoleState.automation` 包含 `available`、`enabled`、`status`（idle／starting／creating／recruiting／recovering／playing／waiting／stopping／stopped／faulted）、`completedMatches`、`sessionId` 和可选的 `errorCode`、`roomId`、`recruitUntil`（ISO 时间或 null）。`recruiting` 为三分钟观众招募阶段，`creating` 为默认建房，`recovering` 为故障恢复或重试等待。新增可选字段为 `recoveryCount`、`lastErrorCode`、`lastErrorAt`、`nextRetryAt`、`heartbeatAt` 和 `lastProgressAt`；时间使用 ISO 格式，前三个历史故障字段恢复成功后仍保留，`errorCode` 在恢复成功后清除。OBS 仅投影 enabled、status、roomId、recruitUntil，不含会话或控制字段。新的对局会话自动成为控制台查询和字幕档案的来源。

运行不设场数或时长上限；旧持久配置中的 `run.maxMatches`、`run.maxDurationMs` 在启动时删除并增加配置修订，`config.patch` 不再接受它们，`SessionView` 不再返回 `limits`。普通进程启动后由按钮开启自动出牌，`--auto-start` 则立即启用；人工停止会取消重试。

对局监控每五秒检查权威进展，120 秒无变化、断连或读取超时会撤销当前工作并等待旧执行器退出。父进程还检查两秒心跳及阶段进展，playing／recovering 的阶段进展阈值均为 180 秒；失联时结束旧进程组再启动新工作。可恢复故障进入 `recovering`，按 1–60 秒退避持续重试。恢复刷新桥接废除旧许可，重新证明房主身份、四人友人房和当前对局范围后处理旧局，确认结束及离房，再创建新房、招募和重新同步出牌。恢复不增加已完成场数，不重放旧决策，不删除或伪造旧未决动作的结果。

`BROWSER_CONTROL_WITH_USER`、`LOGIN_REQUIRED`、`CLIENT_VERSION_MISMATCH`、`PROTOCOL_HASH_MISMATCH`、`ROOM_OWNER_REQUIRED`、`ROOM_TERMINATE_REJECTED`、`ROOM_LEAVE_REJECTED`、`GAME_PAGE_AMBIGUOUS`、`INVALID_CLI_ARGUMENTS` 进入 `faulted` 并禁用自动出牌；用户完成登录、配置或房间处理后重新启用。主控制台继续运行，浏览器人工接管不会被自动抢回。错误播报使用固定系统提示，不依赖 LLM；每个来源去重并按一分钟节流，优先于普通解说且尊重静音。

未认证且无法识别已登录画面时，建房等待 90 秒后进入 `LOGIN_REQUIRED`，期间不刷新登录页面；已认证但画面异常最多刷新两次。浏览器桥接版本 5 的 `lobbyAuthenticated` 标志用于判断，未作为控制台公开配置或授权入口。

单次执行器的观察时限独立于直播持续运行。报告为 `MATCH_OBSERVATION_LIMIT` 且观察闭合、弃牌对账与共享台账核验通过时，连续模式保持 `playing`，等待旧执行器释放后以新 `sessionId` 接续同一场，不消耗异常恢复次数、不增加完成场数。停止命令可中止当前接续。核验失败进入故障恢复流程，不能把未闭合观察直接当成正常续局。

整场已结束时，执行器报告的 `matchCompletion.canStartNextMatch` 单独核对完整结算、观察闭合、页面暂停及共享台账无未决动作，并绑定 `gameMatchKey`。该证明成立时，出牌覆盖未通过的 `blocked` 报告仍可正常计入完成场数并确认结算、进入下一轮招募；未覆盖弃牌仍留在报告的诊断中，不计为程序确认。缺少结算、观察尾部未闭合、未决提交或对局身份不一致不会直接进入正常续局，交给故障恢复核验。

### 干净画面转播

实场装配增加 `POST /api/relay/set`，请求为 `{commandId, issuedAt, sessionId, enabled}`，沿用同源检查、严格布尔校验和持久命令去重；未装配返回 `409 UNSUPPORTED_CAPABILITY`。命令结果 `kind` 为 `relay-control`，表示启停请求已处理；异步采集结果通过快照中的 `ConsoleState.relay` 更新。

`relay` 包含 `available`、`enabled`、`status`（idle／starting／live／recovering／stopped／faulted）、`obsUrl`、`previewUrl`、`fps`、`dimensions`（width／height 或 null）、`errorCode`，以及可选的 `recoveryCount` 和 `nextRetryAt`。`enabled` 表示启用意图，恢复期间仍为 true。`RELAY_PORT_IN_USE` 表示独立服务占用了默认端口；`RELAY_START_FAILED` 表示启动失败；`RELAY_CAPTURE_FAILED` 表示采集退出；`RELAY_FRAME_TIMEOUT` 表示 30 秒没有首帧或 45 秒没有新帧。故障以 2–60 秒退避自动恢复，错误不修改自动对局状态，停止转播也不会停止自动出牌。转播上传令牌不进入控制台或 OBS 投影。

转播服务只监听 `127.0.0.1:17362`，`/obs` 为 OBS 浏览器源页面，`/stream.mjpeg` 为只读画面流；与控制台 `/obs` 的字幕源区分。实场默认自动开启，人工关闭偏好持久化，重启后继续关闭直到显式启用。退出控制台会关闭其拥有的转播服务。转播不发送游戏操作，也不接管用户控制权。Debian 的控制台和画面默认通过 SSH 转发访问，网页端点不包含服务器音轨。


## 重置对局显示

`POST /api/display/reset` 接受 `{commandId, issuedAt, sessionId}`，用于实场跟随模式。自动出牌正在启动、执行、等待或停止时返回 `409 AUTOMATION_ACTIVE`；停止后可重置。成功返回 `kind: display-reset`、`sessionId: null`。

重置后控制台和 OBS 清除当前游戏、房间、字幕及当前弃牌列表，暂停引用旧会话。重置状态在配置保存、刷新和控制台重启后仍生效；自动出牌产生新会话后恢复显示。历史台账及决策记录保留，可通过指定历史会话 ID 查询。该命令不操作雀魂页面。
