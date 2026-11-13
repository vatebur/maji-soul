# AI 雀魂直播

支持 Mac arm64 和 Debian 13 的 AI 雀魂直播项目：通过已登录的雀魂页面完成友人场对局，结合专用麻将引擎、通用 LLM、对局解说、B站弹幕、中文语音和 OBS 输出。Mac 可使用 ego，Linux 使用独立 Chromium。

直播控制台持续运行，不设场数或时长上限。监控覆盖出牌异常、对局停滞、工作进程失联和画面采集中断；可恢复异常会在旧执行器退出后重建房间并恢复自动出牌，错误通过固定中文语音通知。干净画面转播默认开启，手动停止和静音仍有效。底层提供 SQLite worker、GameActor、单执行器和脱敏回放；已有实场证据见[验证记录](./docs/validation/phase1-live.md)，跨平台长期运行仍需结合实际登录、音频和直播环境验收。

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

打开终端输出的控制台链接，点击「开始回放」。OBS 字幕源使用同次输出的 `obsUrl`。在 `.env` 配置 `FISH_API_KEY`、`FISH_REFERENCE_ID`，默认模型为 `s2.1-pro-free`；回放加 `--audio` 启用语音，实场模式检测到完整 Fish 配置后自动启用。口播每句带心情标签、最多 19 字，可以聊手牌见解或轻松闲聊。实场收发、OBS 音轨和连续对局说明见[使用说明](./docs/USAGE.md#直播控制台自动出牌与连续对局)。

## 持续直播与 Linux 部署

```sh
# Mac：使用已有 ego 空间和页面，启动即自动对局
npm start -- console --space SPACE_ID --page p1 --live-options /absolute/path/live-options.json --auto-start

# Debian 13：使用已登录的独立 Chromium
npm start -- console --browser-endpoint http://127.0.0.1:9222 --live-options /absolute/path/live-options.json --auto-start
```

Debian 的安装、开机启动、登录和音轨配置见[部署说明](./docs/DEPLOY_DEBIAN.md)，跨平台回归、Linux 引擎、真实 Fish 语音和音轨实测见[迁移验证](./docs/validation/debian-20261113.md)。控制台与 OBS 端点默认只监听 loopback，远程访问使用 SSH 转发。`--auto-start` 在进程启动时开启自动对局；不加时由控制台按钮开启。画面转播自动启动，人工关闭后保持关闭。

## 从这里开始

| 想了解什么 | 阅读入口 |
| --- | --- |
| 产品目标、首版范围与运行约束 | [需求方案](./docs/planning/PLAN.md) |
| 全部文档、阅读顺序与维护规则 | [文档导航](./docs/README.md) |
| Debian 13 安装、登录和开机运行 | [Debian 部署](./docs/DEPLOY_DEBIAN.md) |
| 改善语音自然度 | [VTuber 中文语音方案调查](./docs/research/TTS.md) |
| 如何实现、模块怎样协作 | [程序模型](./docs/design/DOMAIN_MODEL.md) → [架构设计](./docs/design/ARCHITECTURE.md) |
| HTTP、事件流与内部协议 | [HTTP 与事件流](./docs/interfaces/API.md)、[内部接口](./docs/interfaces/INTERNAL_INTERFACES.md)、[OpenAPI](./docs/interfaces/openapi.json) |
| 接下来做什么、如何验收 | [实施与验收](./docs/planning/IMPLEMENTATION.md)、[阶段 1 离线验收与证据归档](./docs/USAGE.md#阶段-1-离线验收) |

## 首版目标

- 四人友人场，新建默认半庄、5+20 秒；招募观众三分钟后给空位补电脑，持续对局直到人工停止。
- 专用引擎与通用 LLM 两种出牌模式，默认专用引擎，只在新小局切换。
- 每次己方弃牌有可追溯的简短文字讲解；观众问答、中文语音和 OBS 展示异步处理。
- 提供控制台、自动故障恢复和错误语音；回放支持暂停、恢复和整场后停止，实场支持随时停止自动出牌。

采用 Node.js／TypeScript 主程序、独立 Rust 引擎进程和本机 SQLite。Akagi `native_bot` 已通过本机 arm64 构建与合成局面推理；Akagi 连续出牌只使用雀魂当前合法候选，整场验收见[本机说明](./docs/USAGE.md#akagi-连续出牌验收)。可选的 [Live2D 口播输出](./docs/USAGE.md#live2d-口播与-obs-角色源)复用当前口播、Fish 语音和 Soullink Emotion SDK，生成与音频同步的动作；角色模型、Profile 与 Cubism Core 需在本机配置，仓库不附带角色资源。

## 仓库结构

```text
README.md                  项目概览
src/domain/                领域状态、规则与确定性 reducer
src/application/           对局协调、决策、解说和语音调度
src/ports/                 浏览器、存储等平台无关接口
src/adapters/              引擎、平台浏览器、雀魂、存储和音频适配
src/app/console/           控制台、进程监护、对局监控、房间恢复与转播
native/engine-runner/       固定版本 Akagi JSONL runner（诊断规则）
scripts/                   当前协议、浏览器与引擎验证脚本
scripts/deploy/            远程同步与部署入口
deploy/debian/             Debian 安装、浏览器启动与 systemd 常驻服务
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
  DEPLOY_DEBIAN.md         Debian 13 部署与运维
.vfox.toml                 项目 Node／Rust 版本
package-lock.json          npm 依赖锁定
.env.example               模型服务配置示例
.gitignore                 本机配置与运行产物忽略规则
```

模型服务字段见 [.env.example](./.env.example)。实际密钥由本机 `.env` 管理，不提交到仓库；后续运行数据和脱敏回放放入被忽略的 `data/`。

当前先完成[自动化门槛实场验收](./docs/validation/automation-gates.md)；[阶段 2 动作映射](./docs/validation/phase2-actions.md)和[跨小局与恢复协调](./docs/validation/lifecycle-coordination.md)已有离线实现，提供 `live-observe` 供实场观察。双模式真实整场与同房续局仍待完成。控制台与 OBS 页面已提供回放演练和台账跟随。完整自动对局仍待实场验收。受控实场命令与固定 live 台账用法见[本机说明](./docs/USAGE.md)。
