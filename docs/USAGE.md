# 本机开发与验证

[项目概览](../README.md) · [技术验证记录](./validation/technical-spikes.md)

提供技术探针、重放／检查／预演、受控实场命令和常驻直播控制台。`npm start` 只显示入口；实场 `console --auto-start` 会立即启用连续对局，不加该参数则由按钮开启。控制台默认自动启动干净画面转播。Mac 开发运行时可使用 vfox，项目版本见 `.vfox.toml`；Debian 13 安装、登录及 systemd 开机运行见[部署说明](./DEPLOY_DEBIAN.md)。

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
- 默认样本来自合成牌局，含两次弃牌和连庄，缺完整整场结果。使用重复的 `--replay <样本目录>` 可串联同一房号的样本。只有上一场提交了权威格式的整场结束事件，才会计数并进入下一个样本。回放在样本耗尽或人工停止时结束；模式切换按新小局生效，回放动作取自样本。
- `--demo-chat` 使用模拟观众和预演回执。演练默认台账为 `data/console/state.sqlite`；使用 `--db` 指向新文件可隔离重复演练。重启活动回放时保留原进度和人工停止意图，打开同一组样本后点击「恢复」。运行不设场数或时长上限，回放在样本耗尽或人工停止时结束。`Ctrl+C` 关闭本机服务与播放器。
- `--follow` 读取同一 SQLite 台账里已提交的公开局面和己方弃牌。重新打开只显示历史档案，新收到且仍在时效内的弃牌才进入播报。游戏动作继续走现有受控实场入口，接管前按下文确认客户端「和」开关。
- `--audio` 使用 Fish Audio 合成 MP3；Mac 使用 `afplay`，Linux 使用 `ffprobe` 验证后交给 `ffplay`，播放器正常退出后记录播完。在 `.env` 设置 `FISH_API_KEY` 和 `FISH_REFERENCE_ID`，实场 `--live-options` 模式检测到这两项后自动启用语音；回放仍使用 `--audio`。`FISH_TTS_MODEL` 默认为 `s2.1-pro-free`（也兼容 `FISH_MODEL`）。当前使用音色 `faccba1a8ac54016bcfc02761285e67f`；每句带 `[犹豫]`、`[纠结]`、`[开心]`、`[难受]` 等中文心情标签，按 [Fish 行内情绪提示](https://github.com/fishaudio/docs/blob/main/developer-guide/core-features/emotions.mdx)传入合成请求；未登记的方括号指令会被移除。合成请求最多 30 秒、响应最多 8 MiB；失败保留字幕，不回退到系统语音。控制台仅显示配置的 Fish 音色，不显示密钥。旧系统语音配置在重启控制台时自动迁移，保留其他设置。OBS 字幕页面本身不播放音频；游戏和语音音轨仍须在部署机器的音频输出与 OBS 中配置并验收。
- 配置 `MAJI_AI_*` 后，`--audio` 自动启用模型解说，也可用 `--commentary` 或控制台「模型解说」启用。口播合并近期局面，按控制台「思路生成最小间隔（秒）」请求 LLM，默认 15 秒，可设置 1–300 秒，保存后生效并在重启后保留。每次生成 1–3 句口语化台词，每句连同心情标签和标点最多 19 字。不固定播牌型或逐动作报牌，可以只聊手牌见解，也可以讲段子、自嘲或聊无关的日常话题；牌局事实仍只能使用当前手牌与公开信息。观众闲聊回复同样限制为带心情的 19 字内一句话，不再朗读整条观众提问。固定招募和历史回顾也会在合成前分成带心情的短句。对局思路生成与对应模型请求最多等待 300 秒，不受通用 `MAJI_AI_TIMEOUT_MS` 的较短设置影响；生成成功后重新计算 20 秒待播时效。未配置、关闭、限流、超时或无效结果会跳过口播，切换小局、清空或静音仍会取消旧任务。事实字幕和弃牌档案仍即时保留，成功的思路同步显示为字幕，牌局观察和回放持续推进。
- 对局解说、闲聊和招募口播仅用于语音及字幕，不会自动发送到弹幕。观众弹幕仍按原有规则选取并发送一条简短文字回复，发送与语音播放独立，继续执行预演、账号和房间校验、禁词、限长、冷却及持久去重。
- 对局思路基于当前已观察的己方手牌、公开局面和最近六次己方弃牌生成。模型分析属于建议，不代表程序真实决策原因，不输出未经计算的精确胜率、向听或进张结果。历史追问仍通过已确认弃牌和冻结决策中的事实模板回答。「查看证据」展示来源与限制。历史追问定位原弃牌和原决策，找不到或有歧义时请求澄清。合成回放缺关联决策时会明确说明。
- 模型响应在语音清空／静音后不会补回待播。更换模型配置、角色或禁词会取消旧的生成任务。档案保留生成时的配置修订，显示和播放时再次执行当前禁词规则。当前控制台独立运行，单进程最多一个直播模型请求；跨游戏／控制台进程共享同一供应商时，仍须另行验证服务容量或配置独立服务。
- 默认保留 7 天的本机命令、弹幕去重和已确定的回发状态。过期的已停止演练按完整会话清理，活动演练和来源游戏台账保留。结果不明的回发保留派发记录。录制文件和用户导出的回放由本机管理。

### Live2D 口播与 OBS 角色源

使用 `--avatar` 或设置 `MAJI_AVATAR_ENABLED=true` 启用角色输出，同时启用 Fish 语音：

```sh
npm run build:avatar
npm start -- console --demo-chat --avatar
# 实场运行时在原有 console 命令后增加 --avatar
```

在 `.env` 配置下列本机资源，并保留原有 `FISH_API_KEY`、`FISH_REFERENCE_ID` 和 `MAJI_AI_*` 设置：

| 配置 | 内容 |
| --- | --- |
| `MAJI_AVATAR_MODEL` | 已绑定的 Live2D `.model3.json` 文件路径；其引用的 `.moc3`、纹理等资源须完整 |
| `MAJI_AVATAR_PROFILE` | 与此角色相匹配的 Soullink Emotion SDK Profile JSON 文件路径 |
| `MAJI_AVATAR_CORE` | 官方 Cubism Core 的 `live2dcubismcore.min.js` 本机路径 |
| `MAJI_AVATAR_NAME` | 可选的角色显示名称 |

动作规划默认沿用 `MAJI_AI_BASE_URL / MAJI_AI_MODEL / MAJI_AI_API_KEY`；可以用 `MAJI_LIVE2D_AI_BASE_URL / MAJI_LIVE2D_AI_MODEL / MAJI_LIVE2D_AI_API_KEY` 单独设置动作模型。可选 `MAJI_LIVE2D_AI_TIMEOUT_MS` 默认 12000 毫秒，范围 1–30000；角色输出仍受当前语音有效期及整体规划等待上限约束。响应格式可用 `MAJI_LIVE2D_AI_RESPONSE_FORMAT=none|json_object|json_schema` 设置，缺省沿用 `MAJI_AI_RESPONSE_FORMAT`，均未配置时为 none。没有有效动作模型时使用本地情绪、待机和音频口型，不声称已生成语义动作。

支持相应字段的模型服务可以设置 `MAJI_LIVE2D_AI_REASONING_EFFORT=none|minimal|low|medium|high`，未配置时不添加 reasoning_effort。当前服务使用 low 的实际请求已返回动作片段，可减少口播前等待；这不改变普通口播文案模型的配置。

项目不附带示例角色，不会把普通图片或 MP4 当作 Live2D 模型。没有配置模型时，角色页面显示缺少的设置；提供可用模型后才能验收角色动作。更换模型需同步校准参数 Profile，不能只更换模型文件名。

OBS 新增一个浏览器源，使用同一控制台地址的 `/avatar`，例如 `http://127.0.0.1:17361/avatar`。这是透明角色层，原 `/obs` 字幕源与 `17362/obs` 游戏画面源仍分别添加。角色模式由角色浏览器源播放语音，在 OBS 为该源启用音频控制；默认本机 `afplay`／`ffplay` 不再同时播放这条语音。先在本地录制中检查语音、游戏音轨和透明背景，再用于直播。

排查配置或浏览器音频权限时打开 `/avatar?debug=1`，显示状态与音频重试操作。单纯查看角色可用 `/avatar?preview=1`，预览页面不申请语音播放权。前端构建产物位于被忽略的 `.runtime/avatar/avatar.bundle.js`，依赖或前端源文件修改后重新运行构建命令。

复杂模型若出现鼻部白块或嘴边异常阴影，可能是渲染器遮罩图集容量不足。当前版本会检测独立遮罩数量，对超容量模型自动启用高精度遮罩；部署更新后须刷新 OBS 浏览器源以加载新构建。不要通过修改表情参数补偿遮罩显示错误。

正式角色页连接后，可以点击控制台的「试听角色」，用固定问候测试当前 Fish、动作规划、播放及口型链路。试听沿用原语音队列，需处于空闲且未静音状态，每次成功请求后冷却 30 秒，不会启动牌局或发送弹幕。

已经生成的口播经过合并、过滤和短句化后，同时用于动作规划和 Fish 合成。Soullink SDK 的自定义 Fish provider 负责语音调用；SDK 自带 provider 不包含 Fish。动作输入沿用 `[开心]`、`[犹豫]` 等心情与口播正文，口型读取同一条实际播放音频；不会再让外部聊天程序生成第二份回答。动作规划失败时保留音频和基础表现，角色输出故障不阻塞自动出牌。

角色待机使用连续的视线、点头、歪头和身体变化，声音尚未启用时也会活动。正常播完保留动作历史，避免每句重演同一个反应；取消或失败仍立即关闭口型、清除当前讲话动作。云规划按约每 2.5 秒一个目标分配，最多 8 个，每次姿态过渡不超过 0.9 秒；头身微动、眨眼和呼吸持续补充细节。每句最多发出一次动作模型请求，失败后使用本地表现。更新 DeepSeek-chan 已有安装时，重新运行 `node scripts/profile-deepseek-avatar.mjs <模型目录> <Core文件>` 生成较明显的待机范围，再构建前端并刷新角色源；脚本会重写该模型的 Profile，自定义校准应先保留。

只保留一个正式播放页面。新预览页不能抢占已有角色播放端；页面失联会停止音频和动作，重新连接不会补播历史内容。「清空待播」保留当前句，「静音」停止当前句及动作并清空待播。换场景、隐藏源、刷新页面和 OBS 重启都可能改变播放页面生命周期，应先录制验证。模型、Cubism Core、中文口型与 OBS 长时间运行的效果需要使用你的资源单独验收。

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

每个小局首次自动采集同 step、同页面的两次同步，间隔至少 2 秒，核对服务器已耗时的秒单位与客户端倒计时。该单位校准只在相同页面、原生恢复版本、对局、小局、房间规则和画面版本内短暂复用，最长五分钟；每个新窗口仍重新同步并读取实际倒计时，旧窗口的剩余时间和截止时间不会复用。重连、换局、校准过期或时钟偏移变化会使缓存失效。每次仍预留完整 RTT＋2 秒量化误差及 250ms 发送余量；过期、不支持的追加时间语义均拒发。最终页面许可最长 1 秒，并受单调时钟和开关复核约束；人工秒数不能替代它。开局首弃没有可验证摸牌实例，仍不开放执行；等待独立 ActionDealTile。`pauseBeforeDispatch:true` 可验证 not-dispatched 且发送计数不增。

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

桥接为状态恢复或倒计时采样发送的 `syncGame` 也需要完成握手：非终局成功响应后，在同一连接、对局和原生恢复代次内发送一次 `finishSyncGame` 并等待成功。同步数据仍使用原 `syncGame` 响应的采样时间，等待完成通知不会延长出牌期限；期间的新事件仍会使旧同步数据失效。原生客户端正在恢复时不抢先发送完成通知，桥接自己的握手也不作为原生画面恢复证明。握手失败保持程序暂停，避免只读取同步历史却把玩家持续留在同步状态。

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

沿用上文的房间配置，`verifiedOptions` 包含 `doraRule: "standard-riichi"` 和 `redFives: 3`。支持四人东、三电脑、25,000 起点、食断及 `displayTimeSetting: "5+20"`、`"60+0"` 或 `"300+0"`。60＋0 表示每次操作上限一分钟，策略完成并通过校验后立即出牌。开播页仍使用 Unity 4.0.51、2036×918 CSS 像素、DPR=1。5＋20 秒核对白色基础倒计时和橙色时间池，首弃可能有额外的基本时间，以当前操作窗口的读回为准。

Akagi 以当前小局的完整可见历史推理，每个动作仍经雀魂候选、操作时间、持久台账和最终页面许可复核。雀魂的合法列表与权威结算决定能否执行，Akagi 内置规则用于本地推理。弃牌和副露只有收到匹配的权威事件才计确认；跳过鸣牌的成功回执单列，之后还需等牌局推进。自动和牌由客户端执行。

一次命令最多运行一场或 30 分钟，`observeMs` 可设更短的测试上限。失败会暂停并写入 `report.json`。在游戏中断后不要换台账绕过未决提交。若在已结算后回到同一个友人房，等待第一场报告落盘和执行器释放页面，随后在同一房开始下一场，再运行 `live-akagi`，使用原数据库和新的输出目录。


### 直播控制台自动出牌与连续对局

Mac 使用已有的活动 Ego TaskSpace 和雀魂页面启动（替换空间 ID、页面标签和配置文件路径）：

```bash
npm start -- console --space SPACE_ID --page p1 --live-options /absolute/path/live-options.json
# 启动程序后立即开始自动对局
npm start -- console --space SPACE_ID --page p1 --live-options /absolute/path/live-options.json --auto-start
# Debian 13 使用独立 Chromium，不能同时传 --space/--page
npm start -- console --browser-endpoint http://127.0.0.1:9222 --live-options /absolute/path/live-options.json --auto-start
```

打开启动输出的 `consoleUrl`，在「对局与运行」点击「启用自动出牌」；使用 `--auto-start` 时已经启用。按钮切换为「停止自动出牌」，可随时停止。已有对局会从当前进度接入；大厅里会自动进入友人场创建四人半庄，按配置选择并核实 5+20 或 60+0 秒，Debian 部署样例使用 5+20。300+0 仅支持接入已创建的房间或对局，尚未校准其自动创建选项。控制台自动跟随每场新台账，无须手动更换 `--follow` 的会话 ID。可叠加 `--audio --commentary --bili-direct`；`--db` 必须与配置中的数据库一致。完整 Fish 配置会自动开启实场语音，错误播报不要求配置 LLM。

控制台默认监听 `127.0.0.1:17361`，干净画面监听 `127.0.0.1:17362`，可分别用 `--port` 和 `--relay-port` 调整。远程访问 Debian 时使用 SSH 转发实际使用的两个端口，浏览器登录和服务器音轨配置见[Debian 部署](./DEPLOY_DEBIAN.md)。网页转发不传输服务器播放的声音。

房间号从服务器读取，每次新建后自动更新，不再使用配置文件里的旧号码。进入自己创建的房间后先招募观众三分钟，控制台与 OBS 显示房间号和倒计时。语音开启后，Fish 通道会在上一句播完后接续播放不重复的邀请，逐位朗读房间号码。停止、换房、到时或开局会取消旧招募的待播和正在播放内容；静音控制仍有效。

每轮招募前先移除上一局或中断补位留下的电脑，清理完成后再开始三分钟倒计时，招募期间保持电脑席位空闲。三分钟内不自动补电脑或提前开局，即使真人已经坐满。到时重新读取人数，只往空位补电脑；真人座位保留，等待所有真人准备后通过客户端「开始」进入游戏。支持 0–3 名电脑、东风或半庄；新建房间保持界面默认值。每场使用独立会话和输出子目录，共用数据库。

无房间、无对局且页面卡住时，建房流程先检查大厅认证。未认证且画面无法识别为已登录界面时等待 90 秒，期间不刷新，随后显示 `LOGIN_REQUIRED` 并停止自动出牌；完成登录后重新启用。已认证但画面异常时最多刷新两次，复用浏览器保存的登录状态。用户接管浏览器、客户端或协议版本不匹配、房主身份不成立以及终止／离房被拒绝也进入需人工处理的故障状态；程序不会抢回用户控制权或绕过这些条件。程序不保存账号密码，也不会自动重发回执不明的开局或出牌。

房间查询与开局使用经过成功原生登录或建房响应验证的大厅连接。客户端额外建立的预登录连接不会替换该通道，避免将未认证连接上的查询失败误判为房间丢失。

整场权威结算入账、报告写完且执行器释放后，程序按校准尺寸确认终局排名及可能出现的任务奖励页，返回房间后重新开始招募流程。每种结算页面只确认一次；页面未变化或结算范围变化时不会重复点击。整场结算完整且观察闭合、共享台账无未决动作时，即使客户端或手动弃牌导致出牌覆盖验收未通过，连续模式仍计入完成场数并正常续局；报告保留 `blocked` 与未覆盖弃牌数量，通过独立的 `matchCompletion.canStartNextMatch` 记录续局条件。已释放的终局桥接仅因牌局连接关闭而标记 `DISCONNECTED` 时，重新启用会先确认结算、保留大厅连接。新对局须完成客户端入场且同步历史包含小局开始记录，才会启动出牌。开局与出牌保留同步、倒计时和合法动作校验。

中途接管时，首次同步归档的历史弃牌记入 `initialOwnDiscards`，不要求由新启动的执行器确认。接管后即使没有新的出牌机会，只要整场结算完整、观察闭合且没有未决动作，也会正常续局；独立整场验收仍要求实际确认弃牌及完整出牌覆盖。

倒计时在画面核验、同步落库、策略或发送准备期间过期，且确认尚未调用发送时，程序撤销当前许可，等待该窗口推进，再用新窗口的完整同步和倒计时继续出牌。同一窗口不会重试。与该窗口严格匹配的下一条权威摸切记录单列为 `expiredWindowDiscards`，不计为程序确认；其余无法解释的弃牌仍会阻断完整出牌覆盖验收及未结束牌局的分段接续。已在同一小局验证过的自动和牌开关每次仍读取新画面，只有需要恢复开关时才重复完整恢复流程。

出牌、同步、流程或连接异常会触发恢复。对局监控每五秒读取权威进展，连续 120 秒无进展、连接中断或健康读取超时会取消当前工作。父进程另监测两秒心跳，30 秒失联或阶段长时间停滞会结束旧进程组并重启；其中对局与恢复阶段的进展阈值为 180 秒。可恢复故障按 1、2、4 秒逐步退避，最多间隔 60 秒，持续重试直到恢复或人工停止。

运行中的监控、执行器退出后以及等待牌桌就绪期间都会检查暂离弹窗：完整提示「檢測到您處於離開狀態，已切換成自動摸切。」或「我回了」按钮任一匹配即可识别。先取消当前工作并等旧执行器退出，确认页面已释放且台账没有未决提交，再重新核验当前画面并点击一次「我回了」。停止旧执行器时沿用其已知控制栅栏，不递增未变更页面的代数；未知或失效栅栏仍走保守失效处理。弹窗消失后重新同步同一场对局，以新执行器继续，不重建房间；暂离期间客户端自动摸切仍保留原记录，不计为程序确认。人工停止、页面或对局变化会阻止点击；持续未消失的弹窗不会被重复点击。识别依据当前 4.0.51 客户端的实测字形，不把任意确认按钮当作暂离提示。

恢复先等待旧执行器退出，刷新桥接废除旧许可；验证当前账号为四人友人房房主、房间身份一致且没有执行器持有许可后，处理旧对局、确认结束并离房，再创建新房、重新招募和同步后恢复自动出牌。旧数据库、未决提交和报告保留，恢复不把旧动作伪装成确认成功，也不重放旧决策。未满足结束／离房条件时等待或报告故障，不同时启动两个执行器。

发生异常时，控制台显示错误、恢复次数和下次重试时间，固定中文提示优先于普通解说播放；同一故障去重，同类连续故障每分钟最多播报一次。提示无需 LLM，但需要有效 Fish 配置和音频输出；手动静音始终有效。播报失败保留字幕和错误状态。

单次执行器最多观察 30 分钟，半庄超过此时长时，连续模式会核对观察已闭合、弃牌对账一致、共享台账没有未决动作且页面已暂停并释放，再以新会话接续同一场。接续期间保持「自动出牌中」，不重新招募或开局、不增加完成场数，也不消耗异常恢复次数。观察到时若尚在策略阶段则停止本次发送；已经发送的动作仍保留完整的确认等待时间。报告以 `MATCH_OBSERVATION_LIMIT` 记录分段到时，只有整场权威结算完成才计一场。独立整场验收仍需在观察时限内完成。

控制台已移除场数和时长上限，旧配置中的这两项在启动时自动迁移删除。点击停止或退出控制台会暂停程序执行并处理已提交动作。普通重启后由按钮开启；传入 `--auto-start` 或使用 Debian 的 systemd 服务时，进程启动即启用。客户端的自动和牌开关沿用现有行为，程序停止不代表客户端自动和牌已关闭。

### 干净画面转播到 OBS

实场控制台自动开启「干净画面转播」，与自动出牌独立运行，不需要另开终端运行转播脚本。面板提供「启动转播／停止转播」，可查看实时帧率、当前尺寸，并勾选「显示预览」。Mac ego 页面需要允许 Agent 操作，Linux 则连接配置的 Chromium 页面。

点击「复制 OBS 地址」，在 OBS 添加「浏览器」源，粘贴地址，并按面板提示填写宽高。默认地址为 `http://127.0.0.1:17362/obs`，画面不含 ego 蓝色遮罩或浏览器工具栏；声音继续使用 OBS 的音频采集。此地址提供游戏画面，控制台顶部的「OBS 字幕」仍是单独的字幕源。

停止转播不会停止自动对局；退出控制台会关闭由它启动的转播。正常重启会自动开启，人工关闭的偏好跨重启保留，直到再次点击启动。采集退出、30 秒没有首帧或 45 秒没有新帧时，转播按 2–60 秒退避自动恢复；面板显示恢复状态和重试时间。地址被占用时等待重试，不关闭其他服务。静止页面的帧率可能下降；帧率是实际收到的画面数，不代表端到端延迟。


牌局已结束但控制台仍显示旧场次时，点击「重置对局显示」。控制台与 OBS 会清空旧局面、字幕和当前弃牌列表，进入等待新对局状态；刷新或重启后旧场次不会重新出现，下一场新会话会自动接入。历史记录保留。自动出牌运行时需先停止，再重置。
