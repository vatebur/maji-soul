# 本机开发与验证

[项目概览](../README.md) · [技术验证记录](./validation/technical-spikes.md)

当前提供技术探针、阶段 1 重放／检查／预演和受控实场命令。`npm start` 不会自动开局或连续出牌；`live-once` 才会显式尝试一次摸切。本机控制台和 OBS 字幕支持回放演练及已提交台账跟随。运行时使用 vfox，项目版本见 `.vfox.toml`。

## 安装与检查

```sh
vfox add nodejs
vfox add rust
vfox install nodejs@24.22.1
vfox install rust@1.93.1
vfox use -p nodejs@24.22.1
vfox use -p rust@1.93.1
vfox exec nodejs@24.22.1 -- npm ci
vfox exec nodejs@24.22.1 -- npm run doctor
vfox exec nodejs@24.22.1 -- npm run verify
```

已有插件不用重复 add。已启用 vfox shell 集成时，可在项目目录直接运行 npm／cargo；上述显式 `vfox exec` 适合没有 shell 集成的终端。`npm test` 中的受控 HTTP 测试需要回环监听权限，不访问真实模型。

## 阶段 1 离线验收

```sh
npm run acceptance:offline
```

测试入口保留原 50 项（交接 10 项、手动输入后读回 12 项、UI 驱动 28 项），另覆盖合法候选、失败帧留存和归档完整性。测试通过模拟页面、合成画面和临时台账验证边界，也随 `npm test` 运行。只运行这一入口时无需回环监听、浏览器、原台账或下载协议缓存。

归档已停止写入的观察记录时，指定源根目录、运行标签和一个尚不存在的输出目录。例如将既有 `ui-autowin-2` 的报告、审计和帧副本收拢到被 Git 忽略的目录：

```sh
npm run acceptance:archive -- data/validation/automation-20261106-4ahIRV ui-autowin-2 \
  data/validation/ui-autowin-2-offline-archive --manual-frames /private/tmp
```

`--manual-frames` 仅用于旧记录中存放在独立目录的手动截图；归档按审计记录中的运行标签和序号查找帧。输出可能包含原始协议、截图及其他私有数据，请保存在 `data/`。归档保留原文件字节和原报告状态，并在 `manifest.json` 中登记相对路径、大小、SHA-256、缺失项及可识别的引用异常。命令成功表示副本写入完成。报告中的权威结算、输入归因与各门槛结果仍须各自核对。

UI 驱动的逐次读回审计保留作用域、结果和失败原因；有截图的失败帧随记录保存。后续作用域失效的失败记录可能仍包含此前的 ACK，须按它实际对应的时点使用。每次脚本输入保留预留、输入前帧及指针结果，并对弃牌保留同场、同局、同游标的权威弃牌事实。跳过只核对窗口推进。手动读回 helper 由调用方提供 `retainFailureFrame` 持久化失败截图，文件应存入 `<label>-ui/`，并返回其文件名供审计和归档定位。

上述 npm 入口只读本机证据或运行模拟测试。驱动和交接模块由单一受控观察端显式装配。驱动需传入证据目录、绝对台账路径和像素参考源。`createTilePixelReader` 读取调用方的 `sourceDirectory`、`sources` 和 `skipSourceName`。每条 `sources` 用 `name` 指向 `maji-<name>.png`，用 `sha256` 固定原始截图，用 `labels` 标记 13 或 14 个可见槽位，未知槽位填 `null`。参考图及标签由本机保管。真实操作继续遵循当前暂停安排。自动和牌真实触发和权威整场结束仍按[自动化门槛](./validation/automation-gates.md)验收。

## 状态重放、检查与预演

```sh
vfox exec nodejs@24.22.1 -- npm start -- replay tests/fixtures/phase1-discard
vfox exec nodejs@24.22.1 -- npm start -- dry-run tests/fixtures/phase1-discard --candidate 13
# 将 DATABASE_PATH 替换为上条输出的 databasePath：
vfox exec nodejs@24.22.1 -- npm start -- inspect DATABASE_PATH fixture-phase1-discard
```

`replay` 校验 manifest 的 schema／reducer 版本和事件摘要，经实际 SQLite worker 与 GameActor 重放，再比较 `expected.json` 中的最终状态摘要、序号、手牌和弃牌事实数。内置样本有 17 条合成事件，涵盖红五、重复普通五实例、他家隐藏摸牌、己方两次弃牌和连庄换小局；它不是实场录制。

每次运行默认新建 `data/replay-runs/<run-id>/`，其中 `state.sqlite` 保存事件／快照／动作审计，`report.json` 保存结果；可用 `--out <新目录>` 指定位置，已有目录会拒绝覆盖。`inspect` 使用只读连接，不接管会话或改变恢复状态；其中局面是离线检查点，恢复执行仍需要新的权威同步。

`dry-run` 在重放结束的当前窗口中选择候选索引（从 0 开始，默认 0），经冻结快照、认领和最终许可校验后记录 `simulated`。样本候选 13 是红五摸切。索引只是预演选择，不代表 AI 策略或本地规则；预演装配没有传输端，不连接游戏／模型，也不发声或发弹幕。`simulated` 不占程序提交槽位、不生成动作确认。

```sh
# 修改领域规则后，只有审核预期变化后才重新生成样本；不为让测试通过而盲目刷新。
vfox exec nodejs@24.22.1 -- node scripts/build-phase1-fixtures.ts
```

当前回放导入接受明确标记 `synthetic` 或 `live-capture` 的严格 v1 领域资产。阶段 0 的诊断摘要缺少字段，不能直接改名导入。真实样本可运行 `npm start -- replay tests/fixtures/phase1-live-discard`；其中操作窗口和许可已剥离，不支持重新出牌。范围见[实场验收](./validation/phase1-live.md)。

## 阶段 3、4、5 直播演练

```sh
npm start -- console --demo-chat
# 使用 .env 中的 Fish Audio 音色合成，在本机播放
npm start -- console --demo-chat --audio
# 启用 .env 配置的模型解说，口播会发送当前己方手牌、公开局面和近期弃牌
npm start -- console --demo-chat --audio --commentary
# 跟随既有实场台账中的会话，替换 SESSION_ID
npm start -- console --follow SESSION_ID --db data/live/state.sqlite
# 读取本机登录文件，直接连接 B 站；启动后在控制台填写房间号并保持预演
npm start -- console --follow SESSION_ID --db data/live/state.sqlite --bili-direct
# 独立只读验收，不需要游戏台账，不发声、不回复弹幕
npm start -- bili-check 1992099976 --seconds 30
```

- 直接打开终端输出的 `consoleUrl`，无需登录或一次性令牌，能访问控制台即可操作。控制台与 OBS 默认使用 `127.0.0.1:17361`，可用 `--port` 修改。OBS 浏览器源只填 `obsUrl`，例如 `http://127.0.0.1:17361/obs`。
- 默认样本来自合成牌局，含两次弃牌和连庄，缺完整整场结果。使用重复的 `--replay <样本目录>` 可串联同一房号的样本。只有上一场提交了权威格式的整场结束事件，才会计数并进入下一个样本。达到 3 场或 60 分钟时完成当前场后停止。模式切换按新小局生效，回放动作取自样本。
- `--demo-chat` 使用模拟观众和预演回执。演练默认台账为 `data/console/state.sqlite`；使用 `--db` 指向新文件可隔离重复演练。重启活动回放时保留原进度和限额，打开同一组样本后点击「恢复」。`Ctrl+C` 关闭本机服务与播放器。
- `--follow` 读取同一 SQLite 台账里已提交的公开局面和己方弃牌。重新打开只显示历史档案，新收到且仍在时效内的弃牌才进入播报。游戏动作继续走现有受控实场入口，接管前按下文确认客户端「和」开关。
- `--audio` 使用 Fish Audio 合成 MP3，`afplay` 正常退出后记录播完。在 `.env` 设置 `FISH_API_KEY` 和 `FISH_REFERENCE_ID`，`FISH_TTS_MODEL` 默认为已试听的 `s2.1-pro-free`（也兼容 `FISH_MODEL`）。当前使用音色 `faccba1a8ac54016bcfc02761285e67f`；不附加开心或其他情绪提示，并移除文本中的方括号指令。合成请求最多 30 秒、响应最多 8 MiB；失败保留字幕，不回退到系统语音。控制台仅显示配置的 Fish 音色，不显示密钥。旧系统语音配置在重启控制台时自动迁移，保留其他设置。OBS 页面只显示字幕。游戏和语音双音轨录制仍需本机 OBS 验收。
- 配置 `MAJI_AI_*` 后，`--audio` 自动启用模型解说，也可用 `--commentary` 或控制台「模型解说」启用。口播合并近期局面，按控制台「思路生成最小间隔（秒）」请求 LLM，默认 15 秒，可设置 1–300 秒，保存后生效并在重启后保留，输出最多 160 字的对局思路，说明手牌方向及攻守考虑，不再逐动作报牌。对局思路生成与对应模型请求最多等待 300 秒，不受通用 `MAJI_AI_TIMEOUT_MS` 的较短设置影响；生成成功后重新计算 20 秒待播时效。未配置、关闭、限流、超时或无效结果会跳过口播，切换小局、清空或静音仍会取消旧任务。事实字幕和弃牌档案仍即时保留，成功的思路同步显示为字幕，牌局观察和回放持续推进。
- 对局思路基于当前已观察的己方手牌、公开局面和最近六次己方弃牌生成。模型分析属于建议，不代表程序真实决策原因，不输出未经计算的精确胜率、向听或进张结果。历史追问仍通过已确认弃牌和冻结决策中的事实模板回答。「查看证据」展示来源与限制。历史追问定位原弃牌和原决策，找不到或有歧义时请求澄清。合成回放缺关联决策时会明确说明。
- 模型响应在语音清空／静音后不会补回待播。更换模型配置、角色或禁词会取消旧的生成任务。档案保留生成时的配置修订，显示和播放时再次执行当前禁词规则。当前控制台独立运行，单进程最多一个直播模型请求；跨游戏／控制台进程共享同一供应商时，仍须另行验证服务容量或配置独立服务。
- 默认保留 7 天的本机命令、弹幕去重和已确定的回发状态。过期的已停止演练按完整会话清理，活动演练和来源游戏台账保留。结果不明的回发保留派发记录。录制文件和用户导出的回放由本机管理。

### B 站直连与本机登录

在 `.env` 设置 `MAJI_BILI_COOKIE_FILE=data/local/bilibili.cookie`。该文件只在本机保存，内容为 B站登录会话的 Cookie 行，需包含 `SESSDATA`、`bili_jct`、`DedeUserID`，可含 `buvid3`。使用已登录浏览器或开发者工具在本机获取这些字段，不能通过聊天发送。文件需为普通文件且权限为 `0600`，程序拒绝公开可读文件和符号链接。`data/` 与 `.env` 均已忽略提交。登录失效后更新本机文件并重启连接。

`bili-check <房间号> --seconds <1–300>` 先验证账号，再解析短房号、完成弹幕认证并统计逐条消息。只读报告保存于 `data/validation/`，包含连接状态、收取数量、缺口及脱敏错误码，不包含 Cookie、用户名或弹幕正文。连接成功但未收到可验证消息时为 partial，不计作完整收消息验收。

`--bili-direct` 只用于 `--follow` 台账跟随，不能与合成回放或 `--demo-chat` 混用。控制台显示实际房间、已验证账号、接收数和跳过数。入站缺少稳定用户身份或源消息 ID 时跳过互动并显示缺口。断线以有上限的退避重连；缓冲溢出也明确显示缺口，不声称补齐历史。平台拒绝访问、登录失效或限流时停止自动重试，更新配置后重启服务。

预演默认开启，真实回发仍经统一禁词、20 字上限、频率限制和持久去重。每次发送前重新验证账号；只有返回平台消息 ID 的成功响应才记 published，成功但无消息 ID、超时或回执不明记 uncertain 且不重发。没有手工发送路由。真实文字回发验收须单独确认目标房间和测试文本。

### B 站本机转发器契约

跟随台账时可用 `MAJI_BILI_RELAY_URL` 和 `MAJI_BILI_RELAY_TOKEN` 配置外部转发器。转发器需监听 `http://127.0.0.1:<port>/`，接管 B 站身份验证、源连接和平台回发。项目只发送 Bearer 凭证到该 loopback 地址。控制台填入房间号后保持预演，可检查身份、自发回声和去重。真实发送需已配置转发器并关闭预演。

| 调用 | 请求与回执 |
| --- | --- |
| `GET /v1/messages?roomId=...&after=...` | 返回 `{roomId,senderId,cursor,gap,messages}`。首次省略 after。messages 每页最多 50 条，每条含 `roomId,messageId,viewerId,displayName,text`，可含 UTC `sourceAt`。senderId 是当前已验证发送账号，messageId 是逐条稳定的源 ID，viewerId 与 senderId 使用同一身份体系。无法续传时将 gap 设为 true。 |
| `POST /v1/replies` | 接收 `{roomId,senderId,deliveryId,text}`。应核对当前账号和房间，仅在平台确认后返回 `{deliveryId,status:"published",receipt}`，明确拒绝时返回 `{deliveryId,status:"rejected"}`。超时或回执模糊时保留不确定记录。 |

直连与转发器的逐项验证见[阶段 3–5 本机验收](./validation/live-output.md)。直连采用的协议参考和许可见[上游登记](./research/UPSTREAM.md)。

## 受控实场单步

先按 ego-browser 技能取得已授权的活动 TaskSpace 与页面，当前支持 Unity WebGL 4.0.51。命令不创建／抢占用户空间，也不自动建房。只有四人东风、300＋0 秒、三电脑友人房可验收；倒计时与自动和牌均由程序截图读回；当前只支持 Unity 4.0.51、2036×918 CSS 像素、DPR=1、未滚动页面。布局或字形无法核实时拒发，不要求人工输入秒数。

```sh
# 示例空间号／页面标签须替换成实际已授权值。
vfox exec nodejs@24.22.1 -- npm start -- live-install 15 p1
# 安装后再开局，确保游戏连接从第一帧经过统一请求号分配。
# 已有游戏连接或需要换执行进程时，受控重载并从新连接捕获：
vfox exec nodejs@24.22.1 -- npm start -- live-reconnect 15 p1
# 页面恢复后自动采集两次同步和倒计时，检测并恢复自动和牌，再执行同步。
vfox exec nodejs@24.22.1 -- npm start -- live-sync 15 p1 /absolute/path/live-options.json
# 新一次运行前重新取得桥接执行代际及新读回；下面命令显式尝试一次摸切：
vfox exec nodejs@24.22.1 -- npm start -- live-once 15 p1 /absolute/path/live-options.json
```

`live-options.json` 最小结构如下；不再填写 `countdown`。房型仍须与认证响应一致，`room.autoWin` 的声明会被当前页面的自动读回替代。`outputDirectory` 必须是尚不存在的绝对目录。

```json
{
  "outputDirectory": "/absolute/path/new-run",
  "room": {
    "roomId": "redacted-friend-room",
    "rules": {
      "players": 4, "length": "east", "displayTimeSetting": "300+0", "computerSeats": 3,
      "verifiedOptions": {"doraRule": "standard-riichi"}, "protocolVersion": "4.0.51"
    },
    "autoWin": "unknown"
  },
  "sourceVersion": "majsoul-4.0.51/proto-1c332959d97f"
}
```

每个窗口自动采集同小局、同 step、同页面的两次同步，间隔至少 2 秒，核对服务器已耗时的秒单位与客户端倒计时，并预留完整 RTT＋2 秒量化误差及 250ms 发送余量。过期、重连旧样本、暂停或不支持的追加时间语义均拒发。最终页面许可最长 1 秒，并受单调时钟和开关复核约束；人工秒数不能替代它。开局首弃没有可验证摸牌实例，仍不开放执行；等待独立 ActionDealTile。`pauseBeforeDispatch:true` 可验证 not-dispatched 且发送计数不增。

报告的 `programPaused`／旧字段 `paused` 仅指程序执行器已暂停；客户端自动和牌开关保持开启，仍可能自行和牌。人工接管时如需关闭它，请在页面关掉“和”并确认。程序不会把这类客户端发送记作程序发送。新增实场验收步骤见[自动化门槛](./validation/automation-gates.md)。

所有运行默认共用 `data/live/state.sqlite`，报告／脱敏 capture 存入新的 outputDirectory。`databasePath` 仅供隔离测试或明确管理同一持久台账；不要为重试另建数据库。旧 uncertain／未决动作须保留原台账并同步对账；新 session 不能绕过。任一阻塞返回 `status:blocked`，CLI 退出码 2；不会自动重试。普通单步结束及异常路径会暂停；远端控制失败关闸。

桥接绑定一个执行进程；一次 `live-sync`、`live-once` 或 `live-observe` 结束后，下一次独立 CLI 运行前先执行 `live-reconnect` 重建桥，再使用原数据库与新的输出目录。旧进程不能直接接管新控制代际。失败报告的 `timingDiagnostics` 与发送计数可用于核对临近截止拒发；采样未完成时不会补造证据。`executionDiagnostic` 记录最近一次提交的阶段和固定错误码；`invocationStarted` 只表示调用了传输函数，实际是否发送仍看回执与桥接计数。

ego helper 只负责页面 RPC，Actor 和 SQLite worker 在启动 CLI 的固定 Node 子进程运行，不依赖 ego helper 的 worker_threads。live-* 保留页面以便人工接管；验收任务结束时先等待 pendingRpcCount=0，调用 `__majiBridge.restore()`，再按技能 `TaskSpace.finish` 交还页面。

## 跨小局观察

安装桥接并取得新连接后，使用同一份房间配置和原 live 台账：

```sh
vfox exec nodejs@24.22.1 -- npm start -- live-observe 15 p1 /absolute/path/live-options.json
```

`live-observe` 默认观察 30 秒，配置可增加 `"observeMs": 1800000`，最多 30 分钟；整场结束会提前收尾，输出目录仍须全新。它保持程序暂停，不创建弃牌决策，也不采集倒计时。初次完整同步及同进程重连同步后，非终局页面会检测“和”开关，必要时点击一次并读回。客户端和人工动作仍会被记录。小局结束、新局、连庄和终局沿用当前 Actor 与原数据库；断线后等待新连接认证完成再完整同步，不自动恢复程序发送。

`autoWinRecovery` 是最近一次开关恢复结果，`autoWinRecoveries` 保留各次初始／重连／新小局记录。像素无法确认时标为 `unverified` 并使报告 blocked，观察仍继续保存权威事件；它不把 UI 失败写成协议故障，也不以历史开关状态授权发送。终局无需操作开关，记录 `not-required`。开关操作期间的新入站仍归约入账。

新小局（包括连庄）另记 `new-hand` 恢复：先保持 `pending`，等当前手的自身非和牌操作窗口与已入账的页面范围一致后，最多尝试一次开启和读回。开关操作前再次核对连接、手内流、代际和步数；等待或失败不会沿用上一局的成功结果，也不会反复点击或恢复程序出牌。首个窗口若为和牌，保持待恢复，不能据此宣称自动和牌已就绪。

开启开关前，初次接入和重连均等待客户端自身的入场／恢复响应。需要恢复历史时还须收到客户端的 `finishSyncGame` 成功响应；桥接程序自己的同步不能代替它。随后连续两次读取已知中心框和开关像素，以排除当前版本的重连弹窗；这不代表能识别任意 Unity 弹窗。等待超时或作用域变化返回 `AUTO_WIN_RECOVERY_NOT_READY`，不点击、不自动重试。新的客户端恢复请求会撤销旧许可和读回；截图携带恢复序号，在页面确认时再次同步校验，防止恢复期间的旧截图重新授权发送。

报告新增 `lifecycle`（边界计数、台账小局序号、当前结束／恢复状态）及 `captureDirectories`。重连后的完整当前小局另存片段，片段序号从 1 重放，manifest 的 `originHandOrdinal` 保留原序号。对每个片段运行 `replay`。结束观察时仍断线、只收到终局标志或只收到最终排名而缺结算时返回 blocked；缺少完整同步历史也不推断状态。`passed` 仅表示本次有时限观察通过，要验证完整整场需另核对最终状态和实际覆盖。详细步骤见[跨小局验证](./validation/lifecycle-coordination.md)。

`observationClosure.settled` 表示最后入账游标与最终页面读回一致，且没有排队事件、故障或断线；收尾期间出现新变化会使报告 blocked。

## 本机与服务探测

```sh
vfox exec nodejs@24.22.1 -- npm run spike -- storage
vfox exec nodejs@24.22.1 -- npm run spike -- speech
vfox exec nodejs@24.22.1 -- npm run spike -- speech --play
vfox exec nodejs@24.22.1 -- npm run spike -- model
```

模型探测从 `.env` 读取既有 `MAJI_AI_*` 字段，只发合成 JSON 请求，不发送牌局数据；会产生三个真实服务请求（一次单独、一次同时两个）。`BASE_URL` 应包含供应商需要的版本前缀，例如 `https://host.example/v1`；适配器追加 `/chat/completions`。`RESPONSE_FORMAT=none` 仍严格解析 JSON，不接受 Markdown、自由文本、额外字段或未知 actionId。探测日志不记录密钥、端点、HTTP 错误正文与生成原文。

语音默认只合成；`--play` 才发声并验证正常结束与受控取消。声音可通过 `MAJI_TTS_VOICE` 指定，须是 `say -v '?'` 已安装的中文声音。运行数据、音频与 SQLite 文件均在 `data/`，不纳入提交。

## Akagi runner

```sh
vfox exec nodejs@24.22.1 rust@1.93.1 -- npm run engine:build
vfox exec nodejs@24.22.1 rust@1.93.1 -- npm run engine:test
vfox exec nodejs@24.22.1 -- npm run spike:engine
```

构建首次需要联网，Cargo.lock 固定解析结果，Akagi 固定 commit。runner 是 JSONL 子进程，没有 HTTP 或游戏连接；输入限 1 MiB，stdout 仅含协议响应。支持 init／reset／advance／replay／decide／shutdown，协议以[内部接口](./interfaces/INTERNAL_INTERFACES.md#4-rust-引擎-runner-协议)为目标。诊断使用 `tenhou-default-probe-only`。Akagi 验收入口使用单独的四人东建议协议，仍按引擎内置规则推理，并由雀魂提供的当前合法候选约束实际动作。立直建议只提供牌名，由程序在已验证的合法候选中绑定摸切或手切。

基准使用物理上可成立的合成手牌，不是实场样本；反复 decide 不推进游戏事实。冷启动和推理延迟会随负载变化。

## 当前客户端协议

```sh
# Python 需带 lzma；仅用于技术提取，不是主程序运行依赖。
sh scripts/prepare-protocol.sh
vfox exec nodejs@24.22.1 -- npm run spike:protocol
```

准备脚本下载固定源码、验证归档摘要，在 `.runtime/protocol-env` 建立隔离依赖，并执行上游 Unity 资源提取器。可通过 `MAJI_PROTOCOL_PYTHON` 指定已有完整 Python。本轮 vfox 已装 Python 3.13.18 缺 `_lzma`，实际使用本机已有 Python 3.12.14；没有修改 vfox Python 或全局 pip 包。固定辅助依赖见 `scripts/protocol-requirements.lock`。

检查命令比对已登记协议摘要，变化时返回 `PROTOCOL_HASH_MISMATCH`；必须重新验证当前客户端并更新版本清单，不能直接改 hash 继续操作。提取结果留在 `.runtime`，没有把第三方客户端资源打进项目分发包。

## 浏览器验证与人工接管

`scripts/ego-metadata-probe.js` 和 `scripts/ego-game-probe.js` 是经 ego Page.evaluate 注入的阶段 0 诊断函数，不提供自动运行 CLI。使用前先读 ego-browser 技能，整个任务只用一个 TaskSpace。后者需注入本机 protobufjs 浏览器构建和本次提取的 proto／RPC map；仅在已确认的机器人友人房内验证。

元数据探针只保存方法名、方向、大小与本地序号，有界队列会显式报告丢弃。游戏探针只保留允许的可见字段，恢复路径只输出解码摘要。诊断 RPC 的许可约束尚未覆盖生产 GamePort 全部检查；保留人工复核，不允许模型或观众调用页面对象。

结束验证时先调用 `__majiGameProbe.restore()`，再调用 `__majiProbe.restore()`，确认全局与监听已移除，并用 TaskSpace.finish 交还页面。不要关闭用户页面或通过重新登录抢占另一处会话。本轮已执行清理并保留友人场页面供人工接管，后续不会由本程序继续出牌。

OBS 字幕、B站直连和转发器入口见上文「阶段 3、4、5 直播演练」。程序不会启动推流；弹幕默认预演，真实回发须在已配置的跟随模式下开启。

## Akagi 连续出牌验收

```sh
npm run engine:build
# 在已登录的空闲大厅安装，随后创建／进入三电脑友人场
npm start -- live-install SPACE_ID p1 --akagi
# 开始游戏，等自己的操作窗口出现，再启动验收
npm start -- live-akagi SPACE_ID p1 /absolute/path/live-options.json
```

沿用上文的房间配置，`verifiedOptions` 包含 `doraRule: "standard-riichi"` 和 `redFives: 3`。支持四人东、三电脑、25,000 起点、食断及 `displayTimeSetting: "5+20"` 或 `"300+0"`。开播页仍使用 Unity 4.0.51、2036×918 CSS 像素、DPR=1。5＋20 秒核对白色基础倒计时和橙色时间池，首弃可能有额外的基本时间，以当前操作窗口的读回为准。

Akagi 以当前小局的完整可见历史推理，每个动作仍经雀魂候选、操作时间、持久台账和最终页面许可复核。雀魂的合法列表与权威结算决定能否执行，Akagi 内置规则用于本地推理。弃牌和副露只有收到匹配的权威事件才计确认；跳过鸣牌的成功回执单列，之后还需等牌局推进。自动和牌由客户端执行。

一次命令最多运行一场或 30 分钟，`observeMs` 可设更短的测试上限。失败会暂停并写入 `report.json`。在游戏中断后不要换台账绕过未决提交。若在已结算后回到同一个友人房，等待第一场报告落盘和执行器释放页面，随后在同一房开始下一场，再运行 `live-akagi`，使用原数据库和新的输出目录。


### 直播控制台自动出牌与连续对局

使用已有的活动 Ego TaskSpace 和雀魂页面启动（替换空间 ID、页面标签和配置文件路径）：

```bash
npm start -- console --space SPACE_ID --page p1 --live-options /absolute/path/live-options.json
```

打开启动输出的 `consoleUrl`，在「对局与运行」点击「启用自动出牌」。按钮切换为「停止自动出牌」，可随时停止。已有对局会从当前进度接入；在配置的友人房内则自动开局。控制台自动跟随每场新台账，无须手动更换 `--follow` 的会话 ID。可叠加 `--audio --commentary --bili-direct`；`--db` 必须与配置中的数据库一致。

启用前应进入配置的四人友人房，由本人担任房主并放入三个电脑。停在大厅时程序不会自动创建或加入房间；等待房间超时会提示「未进入可用的友人房」（`ROOM_NOT_READY`）。`GAME_START_TIMEOUT` 表示已请求开局，但在等待时间内未收到对局连接。

整场权威结算入账、报告写完且执行器释放后，程序保留大厅连接与房间成员关系，识别终局画面并确认返回友人房，再通过客户端的「开始」按钮进入下一场。新对局须完成客户端入场且同步历史包含小局开始记录，才会启动出牌。只允许自己为房主的一人三电脑四人房；房号、电脑数量或开局回执异常会停止并显示原因，开局请求不自动重发。每场使用不同会话和输出子目录，共用原数据库。开局与出牌仍保留原有同步、倒计时和合法动作校验。

控制台的场数和时长上限在点击启用时生效，达到上限后不再开启下一场。点击停止或退出控制台会暂停程序执行并处理已提交动作；重启控制台后需重新点击启用。客户端的自动和牌开关沿用现有行为，程序停止不代表客户端自动和牌已关闭。

### 干净画面转播到 OBS

实场控制台的「干净画面转播」面板提供「启动转播／停止转播」，与自动出牌独立运行。先让雀魂页面处于 Agent 控制状态，再点击启动；不需要另开终端运行转播脚本。可查看实时帧率、当前尺寸，并勾选「显示预览」。

点击「复制 OBS 地址」，在 OBS 添加「浏览器」源，粘贴地址，并按面板提示填写宽高。默认地址为 `http://127.0.0.1:17362/obs`，画面不含 ego 蓝色遮罩或浏览器工具栏；声音继续使用 OBS 的音频采集。此地址提供游戏画面，控制台顶部的「OBS 字幕」仍是单独的字幕源。

停止转播不会停止自动对局；退出控制台会关闭由它启动的转播。重启控制台后需再次点击启动，OBS 地址保持不变。若显示地址已占用，先退出旧的独立转播脚本；控制台不会擅自关闭其他服务。页面关闭或控制权交回用户导致采集中断时，恢复页面的 Agent 控制后重新启动转播。静止页面的帧率可能下降；帧率是实际收到的画面数，不代表端到端延迟。


牌局已结束但控制台仍显示旧场次时，点击「重置对局显示」。控制台与 OBS 会清空旧局面、字幕和当前弃牌列表，进入等待新对局状态；刷新或重启后旧场次不会重新出现，下一场新会话会自动接入。历史记录保留。自动出牌运行时需先停止，再重置。
