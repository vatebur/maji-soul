# AI 雀魂直播

面向 Mac arm64 的 AI 雀魂直播项目：通过已登录的 ego 雀魂页面完成友人场对局，结合专用麻将引擎、通用 LLM、逐手解说、B站弹幕、中文语音和 OBS 输出。

**已实现基础工程、阶段 0 技术探测和阶段 1 离线状态／执行链路（2026-11-05，Asia/Shanghai）。** 提供 SQLite worker、GameActor、确定性 reducer、同步对账、单执行器及 replay／inspect／预演 CLI。阶段 0 的生产桥接等门槛和阶段 1 的实场整链路验收尚未通过，自动运行保持关闭。详见[阶段 0 实测](./docs/validation/technical-spikes.md)、[阶段 1 实现范围](./docs/validation/state-foundation.md)和[恢复验证](./docs/validation/recovery.md)。

使用 vfox 管理项目运行时，安装、启动与验证见[本机开发说明](./docs/USAGE.md)：

```sh
vfox install nodejs@24.22.1
vfox install rust@1.93.1
vfox exec nodejs@24.22.1 -- npm ci
vfox exec nodejs@24.22.1 -- npm run doctor
vfox exec nodejs@24.22.1 -- npm run verify
vfox exec nodejs@24.22.1 -- npm start -- replay tests/fixtures/phase1-discard
vfox exec nodejs@24.22.1 -- npm start -- dry-run tests/fixtures/phase1-discard --candidate 13
```

尚未安装 vfox 插件时先运行 `vfox add nodejs`、`vfox add rust`。当前 `npm start` 显示验证入口，不会开始自动对局。

## 从这里开始

| 想了解什么 | 阅读入口 |
| --- | --- |
| 产品目标、首版范围与运行约束 | [需求方案](./docs/planning/PLAN.md) |
| 全部文档、阅读顺序与维护规则 | [文档导航](./docs/README.md) |
| 如何实现、模块怎样协作 | [程序模型](./docs/design/DOMAIN_MODEL.md) → [架构设计](./docs/design/ARCHITECTURE.md) |
| HTTP、事件流与内部协议 | [HTTP 与事件流](./docs/interfaces/API.md)、[内部接口](./docs/interfaces/INTERNAL_INTERFACES.md)、[OpenAPI](./docs/interfaces/openapi.json) |
| 接下来做什么、如何验收 | [实施与验收](./docs/planning/IMPLEMENTATION.md)、[待补证据](./docs/planning/DESIGN_REVIEW.md#3-实施时仍需补证据) |

## 首版目标

- 四人东风友人场，另三席为电脑；默认最多 3 场或 60 分钟，达到上限后打完当前整场再停。
- 专用引擎与通用 LLM 两种出牌模式，默认专用引擎，只在新小局切换。
- 每次己方弃牌有可追溯的简短文字讲解；观众问答、中文语音和 OBS 展示异步处理。
- 提供本机控制台，支持暂停、人工接管、恢复和整场后停止。

采用 Node.js／TypeScript 主程序、独立 Rust 引擎进程和本机 SQLite。Akagi `native_bot` 已通过本机 arm64 构建与合成局面推理；完整规则与动作映射仍待验证。Live2D 是基础直播之后的[可选扩展](./docs/research/LIVE2D.md)，本轮未引入角色资源。

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

下一步补齐生产采集／同步适配、桥接请求号与最终发送栅栏，以及单步截止时间来源，再把当前离线链路接入友人房验证。控制台、OBS 页面和完整自动对局尚未交付；阶段 2 的完整动作映射与双模式整场仍待实施。
