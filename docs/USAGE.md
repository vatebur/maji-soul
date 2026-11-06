# 本机开发与验证

[项目概览](../README.md) · [技术验证记录](./validation/technical-spikes.md)

当前提供技术探针、阶段 1 重放／检查／预演和受控实场命令。`npm start` 不会自动开局或连续出牌；`live-once` 才会显式尝试一次摸切。生产控制台／OBS 页面尚未实现。运行时使用 vfox，项目版本见 `.vfox.toml`。

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

构建首次需要联网，Cargo.lock 固定解析结果，Akagi 固定 commit。runner 是 JSONL 子进程，没有 HTTP 或游戏连接；输入限 1 MiB，stdout 仅含协议响应。支持 init／reset／advance／replay／decide／shutdown，协议以[内部接口](./interfaces/INTERNAL_INTERFACES.md#4-rust-引擎-runner-协议)为目标。当前 reset 只接受诊断规则 `tenhou-default-probe-only`；不支持友人房规则配置，立直缺参／自动和牌建议会拒绝。完整 GamePort 和唯一候选匹配尚未实现，不能直接将 runner 接到自动动作发送。

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

OBS 与 B站尚无可用启动入口。验收步骤及阻塞见技术验证记录；本工程不会自动推流或发送弹幕。
