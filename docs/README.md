# 文档导航

[项目概览](../README.md)

更新日期：2026-11-05（Asia/Shanghai）。已建立设计基线和阶段 1 生产桥接；普通弃牌、重连同步、发送前暂停已[实场验收](./validation/phase1-live.md)，自动读回／恢复与阶段 2 动作已有离线实现，新增实场证据见[待验收门槛](./validation/automation-gates.md)和[动作映射](./validation/phase2-actions.md)。持续自动运行仍关闭。运行方式见[USAGE.md](./USAGE.md)，范围见[阶段 0](./validation/technical-spikes.md)、[阶段 1](./validation/state-foundation.md)与[恢复验证](./validation/recovery.md)。详细需求和契约仍由各专题维护。

新增[跨小局与恢复协调](./validation/lifecycle-coordination.md)：小局／终局归约、连庄隔离、原台账跨会话校验和 `live-observe` 已通过离线回归，实场观察待完成。

## 按任务阅读

| 任务 | 推荐顺序 |
| --- | --- |
| 了解项目 | [项目概览](../README.md) → [需求方案](./planning/PLAN.md) → [开源调研](./research/RESEARCH.md) |
| 开始实现 | [实施阶段与门槛](./planning/IMPLEMENTATION.md) → [领域模型](./design/DOMAIN_MODEL.md) → [架构](./design/ARCHITECTURE.md) → [内部接口](./interfaces/INTERNAL_INTERFACES.md) |
| 开发控制台或 OBS | [HTTP 与事件流](./interfaces/API.md) → [OpenAPI](./interfaces/openapi.json) → [架构中的页面边界](./design/ARCHITECTURE.md#7-本机控制台与-obs-接口) |
| 评估 Live2D | [Live2D 专题](./research/LIVE2D.md) → [可选输出契约](./interfaces/INTERNAL_INTERFACES.md#54-live2d-角色输出可选扩展草案) → [L0—L3 验收](./research/LIVE2D.md#10-最小实施与验收) |
| 检查交付进度 | [待补证据](./planning/DESIGN_REVIEW.md#3-实施时仍需补证据) → [需求追踪](./planning/IMPLEMENTATION.md#3-需求到模块的追踪) → [完成标准](./planning/IMPLEMENTATION.md#6-完成标准) |

## 全部文档

### 规划与验收 · `planning/`

| 文档 | 解决的问题 |
| --- | --- |
| [需求方案 · PLAN.md](./planning/PLAN.md) | 产品目标、首版范围、运行约束、已确认需求 |
| [实施与验收 · IMPLEMENTATION.md](./planning/IMPLEMENTATION.md) | 实施顺序、需求追踪、关键验证、技术门槛和交付标准 |
| [文档审查与缺口 · DESIGN_REVIEW.md](./planning/DESIGN_REVIEW.md) | 整理记录、待补证据、后续资料的创建时机和静态检查范围 |

### 调研 · `research/`

| 文档 | 解决的问题 |
| --- | --- |
| [开源调研 · RESEARCH.md](./research/RESEARCH.md) | 参考项目、固定源码版本、复用边界、历史验证和待验证项 |
| [Live2D 调研与接入 · LIVE2D.md](./research/LIVE2D.md) | 可选角色前端、口型／表情／动作、播放回执、OBS、版本与许可 |

Live2D 专题同时保留源码调研与接入方案；正式内部类型集中在接口文档中。调研中的日期、Star 和源码版本均为当时快照，本次目录整理未重新核查上游或运行这些项目。

### 设计 · `design/`

| 文档 | 解决的问题 |
| --- | --- |
| [程序模型 · DOMAIN_MODEL.md](./design/DOMAIN_MODEL.md) | 领域实体、状态、事件、合法动作、决策证据、直播内容和持久化模型 |
| [程序架构 · ARCHITECTURE.md](./design/ARCHITECTURE.md) | 模块职责、进程关系、执行流程、并发、恢复和配置 |

文中的“模型”包括业务数据模型和 AI 调用契约，不涉及训练新的麻将模型。目录树描述目标工程，尚未存在的代码目录须在实现阶段创建。

### 接口 · `interfaces/`

| 文档 | 解决的问题 |
| --- | --- |
| [HTTP 与事件流 · API.md](./interfaces/API.md) | 本机身份、控制命令、配置、查询、语音、OBS、SSE、错误和幂等 |
| [内部接口 · INTERNAL_INTERFACES.md](./interfaces/INTERNAL_INTERFACES.md) | 游戏适配、模型调用、Rust runner、弹幕、TTS、存储与 Worker 契约 |
| [OpenAPI 定义 · openapi.json](./interfaces/openapi.json) | HTTP 路径、请求／响应 schema 与示例；OpenAPI 3.1.0，契约版本 `1.0.0-design` |

现有 v1 HTTP 契约尚不包含 Live2D 角色配置、音频下载、播放租约或浏览器回执路由；内部相关类型标为可选扩展草案，启用前须补齐传输契约与验证证据。

## 文档职责与更新规则

| 修改内容 | 主文档 | 需要同步 |
| --- | --- | --- |
| 产品范围与已确认需求 | [需求方案](./planning/PLAN.md) | 实施追踪、受影响的设计和项目概览 |
| 上游事实与证据 | [开源调研](./research/RESEARCH.md)、[Live2D 专题](./research/LIVE2D.md) | 固定版本、采用结论和验证门槛 |
| 领域实体与不变量 | [程序模型](./design/DOMAIN_MODEL.md) | 内部接口、持久化与 HTTP DTO |
| 模块、进程和故障边界 | [程序架构](./design/ARCHITECTURE.md) | 内部接口与实施方案 |
| HTTP 路径、字段与语义 | [OpenAPI](./interfaces/openapi.json) 与 [HTTP 文档](./interfaces/API.md) | 两者的定义、示例、时序和错误行为 |
| 内部方法、消息与回执 | [内部接口](./interfaces/INTERNAL_INTERFACES.md) | 调用双方与相关领域模型 |
| 阶段、测试与交付标准 | [实施与验收](./planning/IMPLEMENTATION.md) | 需求追踪、实际验证记录和[证据缺口](./planning/DESIGN_REVIEW.md) |

同一主题保留一个完整定义，其他文档概述并链接。发现冲突时修正来源和引用，不能单靠“以某文档为准”掩盖矛盾。HTTP 形状由 OpenAPI 定义，业务时序由 HTTP 文档解释；领域不变量、内部消息和可选扩展也须保持一致。

移动或新增文档时同步本导航、项目入口、正文链接和章节目录；本地链接使用相对路径。新增资料放入对应主题目录，文件名保持现有的大写命名方式；验证记录使用小写短横线命名。

## 状态、术语与证据约定

| 标记 | 含义 |
| --- | --- |
| 已确认需求 | 产品范围与用户约定，完整记录在需求方案中 |
| 设计基线／待实现 | 选定的工程方案、数据结构或接口，尚不代表有可运行服务 |
| 源码调研／历史验证 | 固定版本中的事实或旧原型记录，必须保留日期、版本和验证范围 |
| 当前实测 | 新工程在记录的环境中产生的结果，须有步骤、证据类型、观察结果与限制 |
| 可选扩展 | 基础直播之后单独验收的能力，例如 Live2D |

- `session` 指一次连续运行，`match` 指一整场，`hand` 指一个小局；连庄也创建新的 `handId`。详细标识见[领域模型](./design/DOMAIN_MODEL.md#2-标识时间与关联)。
- TypeScript、JSON、目录树和 HTTP 路径当前都是实现契约草案；源码里存在某个功能不等于本机或 OBS 已验收。
- 历史原型的测试数量和上游 README 功能列表不能计入新工程验收；实测不符合设计时，记录差异并同步受影响的文档。
- 配置字段参考根目录 [.env.example](../.env.example)。文档示例不包含密钥、Cookie、认证帧或本机 `.env` 内容；运行日志与脱敏机器样本放入被忽略的 `data/`。

## 后续资料

现已创建[阶段 0 验证记录](./validation/technical-spikes.md)、[阶段 1 实现范围](./validation/state-foundation.md)、[恢复验证](./validation/recovery.md)、[实际采用的上游与许可清单](./research/UPSTREAM.md)和[本机开发说明](./USAGE.md)。其他验证专题在实际产生证据后补齐；创建要求见[文档审查](./planning/DESIGN_REVIEW.md#4-后续文档在何时创建)，正式回放资产结构见[实施方案](./planning/IMPLEMENTATION.md#5-新建验证资产)。
