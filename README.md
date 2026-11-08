# AI 雀魂直播

面向 Mac arm64 的 AI 雀魂直播项目：通过已登录的 ego 雀魂页面完成友人场对局，结合专用麻将引擎、通用 LLM、逐手解说、B站弹幕、中文语音和 OBS 输出。

**已实现阶段 1 状态／执行链路和生产桥接，并通过普通弃牌、重连同步、发送前暂停的实场验收（2026-11-05，Asia/Shanghai）。** 提供 SQLite worker、GameActor、确定性 reducer、单执行器和脱敏实场回放。已补自动倒计时与自动和牌读回、恢复，以及阶段 2 合法动作映射；新链路通过离线回归。Akagi 连续出牌提供独立的实场验收入口，默认启动仍为关闭。详见[实场证据与限制](./docs/validation/phase1-live.md)、[阶段 1 实现范围](./docs/validation/state-foundation.md)和[恢复验证](./docs/validation/recovery.md)。

使用 vfox 管理项目运行时，安装、启动与验证见[本机开发说明](./docs/USAGE.md)：

```sh
vfox install nodejs@24.22.1
vfox install rust@1.93.1
vfox exec nodejs@24.22.1 -- npm ci
vfox exec nodejs@24.22.1 -- npm run doctor
vfox exec nodejs@24.22.1 -- npm run verify
vfox exec nodejs@24.22.1 -- npm run acceptance:offline
vfox exec nodejs@24.22.1 -- npm start -- replay tests/fixtures/phase1-discard
vfox exec nodejs@24.22.1 -- npm start -- dry-run tests/fixtures/phase1-discard --candidate 13
```

尚未安装 vfox 插件时先运行 `vfox add nodejs`、`vfox add rust`。当前 `npm start` 显示验证入口，不会开始自动对局。

## 本机直播演练

```sh
npm start -- console --demo-chat
# 已配置模型和 Fish Audio 时启用证据解说和中文语音
npm start -- console --demo-chat --commentary --audio
```

打开终端输出的控制台链接，点击「开始回放」。OBS 浏览器源使用同次输出的 `obsUrl`。可加 `--audio` 启用 Fish Audio 合成和本机播放；在 `.env` 配置 `FISH_API_KEY`、`FISH_REFERENCE_ID`，默认模型为 `s2.1-pro-free`，不添加情绪提示。弃牌档案、模拟弹幕回发、暂停恢复和运行限额已可用；实场收发、OBS 音轨和真实同房续局的验收状态见[本机使用说明](./docs/USAGE.md#阶段-345-直播演练)与[验证记录](./docs/validation/live-output.md)。

## 从这里开始

| 想了解什么 | 阅读入口 |
| --- | --- |
| 产品目标、首版范围与运行约束 | [需求方案](./docs/planning/PLAN.md) |
| 全部文档、阅读顺序与维护规则 | [文档导航](./docs/README.md) |
| 改善语音自然度 | [VTuber 中文语音方案调查](./docs/research/TTS.md) |
| 如何实现、模块怎样协作 | [程序模型](./docs/design/DOMAIN_MODEL.md) → [架构设计](./docs/design/ARCHITECTURE.md) |
| HTTP、事件流与内部协议 | [HTTP 与事件流](./docs/interfaces/API.md)、[内部接口](./docs/interfaces/INTERNAL_INTERFACES.md)、[OpenAPI](./docs/interfaces/openapi.json) |
| 接下来做什么、如何验收 | [实施与验收](./docs/planning/IMPLEMENTATION.md)、[阶段 1 离线验收与证据归档](./docs/USAGE.md#阶段-1-离线验收) |

## 首版目标

- 四人东风友人场，另三席为电脑；默认最多 3 场或 60 分钟，达到上限后打完当前整场再停。
- 专用引擎与通用 LLM 两种出牌模式，默认专用引擎，只在新小局切换。
- 每次己方弃牌有可追溯的简短文字讲解；观众问答、中文语音和 OBS 展示异步处理。
- 提供本机控制台，支持暂停、人工接管、恢复和整场后停止。

采用 Node.js／TypeScript 主程序、独立 Rust 引擎进程和本机 SQLite。Akagi `native_bot` 已通过本机 arm64 构建与合成局面推理；Akagi 连续出牌只使用雀魂当前合法候选，整场验收见[本机说明](./docs/USAGE.md#akagi-连续出牌验收)。Live2D 是基础直播之后的[可选扩展](./docs/research/LIVE2D.md)，本轮未引入角色资源。

## 仓库结构

```text
README.md                  项目概览
src/                       状态领域、GameActor、执行器、存储 worker、CLI 与技术探测
native/engine-runner/       固定版本 Akagi JSONL runner（诊断规则）
scripts/                   当前协议、浏览器与引擎验证脚本
tests/                     状态、恢复、执行边界测试与明确标注的合成回放样本
config/versions.json        实测版本与摘要
docs/
  README.md                文档导航、阅读路径与维护规则
  planning/                需求、实施与验收、待补证据
  research/                上游调研与 Live2D 专题
  design/                  领域模型与架构
  interfaces/              HTTP、内部接口与 OpenAPI
  validation/              本轮实测、限制和采用结论
  USAGE.md                 安装、验证、清理与接管
.vfox.toml                 项目 Node／Rust 版本
package-lock.json          npm 依赖锁定
.env.example               模型服务配置示例
.gitignore                 本机配置与运行产物忽略规则
```

模型服务字段见 [.env.example](./.env.example)。实际密钥由本机 `.env` 管理，不提交到仓库；后续运行数据和脱敏回放放入被忽略的 `data/`。

当前先完成[自动化门槛实场验收](./docs/validation/automation-gates.md)；[阶段 2 动作映射](./docs/validation/phase2-actions.md)和[跨小局与恢复协调](./docs/validation/lifecycle-coordination.md)已有离线实现，提供 `live-observe` 供实场观察。双模式真实整场与同房续局仍待完成。控制台与 OBS 页面已提供回放演练和台账跟随。完整自动对局仍待实场验收。受控实场命令与固定 live 台账用法见[本机说明](./docs/USAGE.md)。
