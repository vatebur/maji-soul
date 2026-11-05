# 阶段 1：状态与执行基础

[文档导航](../README.md) · [实施计划](../planning/IMPLEMENTATION.md) · [运行命令](../USAGE.md)

2026-11-05，Mac arm64／Node 24.22.1。离线链路及生产桥接已实现，普通弃牌、重连同步和发送前暂停已通过[当前客户端验收](./phase1-live.md)。合成回放与故障注入仍单独标记；倒计时／自动和牌人工读回，持续自动运行保持关闭。

## 已实现

| 模块 | 行为与边界 |
| --- | --- |
| 领域与 schema | 严格判别事件、已知／未知字段、绝对座位、红五及实体牌引用；非法字段、隐藏牌、可见牌数量矛盾拒绝归约 |
| reducer | 确定性重放；摸牌／弃牌、公开鸣牌／杠、立直事实、宝牌、窗口、小局与整场边界；连庄独立 handId，pendingMode 只在新手采用 |
| 采集投影 | 开局、摸弃、公开吃碰明杠及立直接受白名单转换；原始动作私有指纹去重，隐藏牌不落盘；未知操作／变体关闸 |
| SQLite worker | v1→v2 兼容迁移、WAL／FULL、0600；事务保存事件／检查点／弃牌事实／outbox；live／contract-test 审计分开，未决共用槽位 |
| GameActor | 有界串行邮箱；先提交再替换状态；源键去重、冲突／漏序号关闸；暂停立即撤销许可，不等待存储 |
| 同步 | 只有完整且自洽的当前视图可恢复信任；新 epoch 重建牌引用；同局保留模式；完整当前状态与完整引擎历史分别判断 |
| 冻结与执行 | 深复制＋冻结＋SHA-256，候选 ID 属于决策；一次性许可核对状态／窗口／控制代际／待处理消息／单调时钟预算 |
| 尝试与确认 | 独占窗口与源游标槽位；跨会话未决阻止再发；回执与游戏事实分离；每次己方弃牌唯一 outbox |
| CLI | `replay`、只读 `inspect`、无传输能力的 `dry-run`；每次使用新目录，拒绝覆盖现有数据库 |
| 生产桥接 | Unity 新连接统一 wire 请求号；有界连续采集、完整同步、入站代际／源 step／一次性许可／最终发送栅栏；受控 live 命令复用固定台账 |

源码入口：[领域](../../src/domain/game/types.ts)、[reducer](../../src/domain/game/reducer.ts)、[Actor](../../src/application/game/actor.ts)、[执行器](../../src/application/game/executor.ts)、[存储接口](../../src/ports/storage.ts)、[迁移](../../src/adapters/storage/migrations/001-state.sql)。

## 回放证据

受版本管理的资产为 [`tests/fixtures/phase1-discard`](../../tests/fixtures/phase1-discard/manifest.json)，由 [`build-phase1-fixtures.ts`](../../scripts/build-phase1-fixtures.ts) 确定性生成。manifest 明确标记 `synthetic`，固定 schema 1、reducer 1.0.0、虚拟时钟和事件摘要。`eventsSha256` 是解析后的事件数组经 canonical JSON 得到的 SHA-256，不是 JSONL 文件字节摘要。

实测 `replay`：17 条事件、序号 17、2 条唯一己方弃牌事实、最终小局序号 2；最终状态 SHA-256 为 `001ee8ab4c67ad71ffc17a7b83467726fa859e96fb09bbe123aba29a8b5269f0`。`dry-run --candidate 13` 选中红五摸切，状态 `simulated`，发送和权威确认均为 0。每次 CLI 输出数据库及 `report.json` 的绝对路径；运行产物位于忽略的 `data/replay-runs/`。

状态、采集、存储、跨模块时序和 CLI 测试位于 `tests/{reducer,normalizer,storage,actor,execution,replay}.test.ts`；恢复案例见[专题](./recovery.md)。旧 Rust runner 本轮未改变，其实测结论仍以阶段 0 记录为准。

离线基线最初为 60 项通过；生产桥接、迁移、同步、child／worker 和实场回放测试已继续增加。当前最终结果见[实场记录](./phase1-live.md)，不把 Node 测试数计作 Rust 或服务器实场次数。

## 相对目标契约的实现子集

设计文档继续描述完整目标，当前类型定义是严格的阶段 1 子集：

- `sourceDedupKey` 和唯一小局来源键必需；游标使用 `<手级 stream>:<源 step>`。本地收包计数不作源游标。桥接先对完整动作私有指纹去重；一包拆出多个领域事件时只有主事实带游标。手级来源用 game UUID 摘要和权威开局摘要跨重连绑定，首版装配限定当前手。
- 可执行候选仅普通弃牌；`tsumo` 只保留客户端自动和牌仲裁语义。公开吃碰杠／立直事实可验证归约，不代表程序提交这些动作已实现。候选不能包装未知操作码继续执行。
- 无匹配客户端倒计时读回时，操作截止时间仍为 unknown；当前实场以人工截图读回验收，尚无无人值守来源。Actor 的 250 ms 预留、1 秒许可、64 项邮箱／RPC 是本地默认值，不是服务器时延保证。
- 生产 `ResSyncGame` 适配器从完整当前小局 actions 逐步重建视图，对照 next-step、逐家牌河与鸣牌。snapshot-only、漏步与未知动作拒绝；阶段 0 摘要不能冒充正式回放。
- 执行器支持 `dry-run`、`contract-test` 与 `live`；证据来源分别保留。live 经真实 Node 子进程／worker 与 ego 页面通信，CLI 仅提供显式单步，不接 AI 策略或连续运行。
- 房间／整场／小局元数据目前保存在事务检查点中；独立业务表、HTTP 控制面、live consumer、7 天保留清理、运行限额在后续阶段实现。现有 outbox 仅归档事实，尚不生成解说、语音或弹幕。

## 下一步验收

1. 建立无人值守倒计时和自动和牌读回，验证 near-deadline 预算；重连后实际自动和牌设置会关闭。
2. 扩展当前手装配到跨小局协调，补完整规则和阶段 2 动作映射；开局首弃不猜摸切，等待独立摸牌事件。
3. 保留[本轮实场资产](../../tests/fixtures/phase1-live-discard/manifest.json)，继续补罕见动作、结束状态和故障组合实场覆盖。

阶段 2 的完整动作、引擎规则／候选映射、LLM／本地规则与双模式整场，以及阶段 0 的 OBS、B站和模型许可缺口仍按实施计划推进。
