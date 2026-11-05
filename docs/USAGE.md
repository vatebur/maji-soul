# 本机开发与验证

[项目概览](../README.md) · [技术验证记录](./validation/technical-spikes.md)

当前提供技术探针与阶段 1 离线重放、检查和预演。`npm start` 不会自动连接雀魂、开局或出牌；生产控制台／OBS 页面尚未实现。运行时使用 vfox，项目版本见 `.vfox.toml`。

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

当前回放导入只接受明确标记 `synthetic` 的 v1 资产。阶段 0 的真实诊断摘要缺少完整鸣牌等字段，不能直接改名导入为完整实场回放。实现子集和下一步门槛见[状态基础](./validation/state-foundation.md)。

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
