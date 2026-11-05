# 阶段 1：状态与执行基础

[文档导航](../README.md) · [实施计划](../planning/IMPLEMENTATION.md) · [运行命令](../USAGE.md)

2026-11-05，Mac arm64／Node 24.22.1。已完成离线链路；阶段 1 的当前客户端整链路验收尚未完成。本轮证据为合成回放、受控时序和本机 SQLite worker，不计作真实牌局兼容性证据。生产自动操作继续关闭。

## 已实现

| 模块 | 行为与边界 |
| --- | --- |
| 领域与 schema | 严格判别事件、已知／未知字段、绝对座位、红五及实体牌引用；非法字段、隐藏牌、可见牌数量矛盾拒绝归约 |
| reducer | 确定性重放；摸牌／弃牌、公开鸣牌／杠、立直事实、宝牌、窗口、小局与整场边界；连庄独立 handId，pendingMode 只在新手采用 |
| 采集投影 | 已解码 `ActionDealTile`／`ActionDiscardTile` 白名单转换；不保留原始帧、身份或他家隐藏摸牌；未覆盖操作、规则转换拒绝 |
| SQLite worker | v1 迁移、WAL／FULL、0600、单事务事件／检查点／弃牌事实／outbox；有界白名单 RPC，写入结果不明时关闸 |
| GameActor | 有界串行邮箱；先提交再替换状态；源键去重、冲突／漏序号关闸；暂停立即撤销许可，不等待存储 |
| 同步 | 只有完整且自洽的当前视图可恢复信任；新 epoch 重建牌引用；同局保留模式；完整当前状态与完整引擎历史分别判断 |
| 冻结与执行 | 深复制＋冻结＋SHA-256，候选 ID 属于决策；一次性许可核对状态／窗口／控制代际／待处理消息／单调时钟预算 |
| 尝试与确认 | 独占窗口与源游标槽位；跨会话未决阻止再发；回执与游戏事实分离；每次己方弃牌唯一 outbox |
| CLI | `replay`、只读 `inspect`、无传输能力的 `dry-run`；每次使用新目录，拒绝覆盖现有数据库 |

源码入口：[领域](../../src/domain/game/types.ts)、[reducer](../../src/domain/game/reducer.ts)、[Actor](../../src/application/game/actor.ts)、[执行器](../../src/application/game/executor.ts)、[存储接口](../../src/ports/storage.ts)、[迁移](../../src/adapters/storage/migrations/001-state.sql)。

## 回放证据

受版本管理的资产为 [`tests/fixtures/phase1-discard`](../../tests/fixtures/phase1-discard/manifest.json)，由 [`build-phase1-fixtures.ts`](../../scripts/build-phase1-fixtures.ts) 确定性生成。manifest 明确标记 `synthetic`，固定 schema 1、reducer 1.0.0、虚拟时钟和事件摘要。`eventsSha256` 是解析后的事件数组经 canonical JSON 得到的 SHA-256，不是 JSONL 文件字节摘要。

实测 `replay`：17 条事件、序号 17、2 条唯一己方弃牌事实、最终小局序号 2；最终状态 SHA-256 为 `001ee8ab4c67ad71ffc17a7b83467726fa859e96fb09bbe123aba29a8b5269f0`。`dry-run --candidate 13` 选中红五摸切，状态 `simulated`，发送和权威确认均为 0。每次 CLI 输出数据库及 `report.json` 的绝对路径；运行产物位于忽略的 `data/replay-runs/`。

状态、采集、存储、跨模块时序和 CLI 测试位于 `tests/{reducer,normalizer,storage,actor,execution,replay}.test.ts`；恢复案例见[专题](./recovery.md)。旧 Rust runner 本轮未改变，其实测结论仍以阶段 0 记录为准。

最终执行 `vfox exec nodejs@24.22.1 -- npm run verify`：TypeScript 检查通过，60 项 Node 测试（含子测试）全部通过，无跳过或失败。该数量包含原有 Node 契约测试，不包含之前的 Rust 单元／进程验证；CLI 回放和预演亦已单独运行。

## 相对目标契约的实现子集

设计文档继续描述完整目标，当前类型定义是严格的阶段 1 子集：

- `sourceDedupKey` 和唯一小局来源键在本实现中必需；游标使用 `<已验证手级 stream>:<源 step>`。本地收包计数不能填这个字段。一个协议动作拆出多个领域事件时，只有主事实带游标，其余事件使用独立稳定去重键。原始包须在调用转换器前去重；连续浏览器采集装配尚未实现。
- 可执行候选仅普通弃牌；`tsumo` 只保留客户端自动和牌仲裁语义。公开吃碰杠／立直事实可验证归约，不代表程序提交这些动作已实现。候选不能包装未知操作码继续执行。
- 实时转换生成的操作截止时间始终为 unknown。合成样本中的 60 秒为测试输入；Actor 的 250 ms 安全预留、1 秒许可、64 项邮箱／RPC 容量是本地配置默认值，不是服务器规则或实场时延结论。
- 同步输入需完整视图；部分历史的确认事实还须有河牌中稳定源引用，完整历史则逐家对照弃牌顺序。当前还没有把实际 `ResSyncGame` 组装为这一结构的生产适配器；阶段 0 摘要不能冒充完整回放。
- 执行器只有 `dry-run` 和显式 `contract-test` 假传输。数据库中的契约测试确认标记为 `contract-test`，不计作真实动作成功。CLI 不装配假传输或真实网络端。
- 房间／整场／小局元数据目前保存在事务检查点中；独立业务表、HTTP 控制面、live consumer、7 天保留清理、运行限额在后续阶段实现。现有 outbox 仅归档事实，尚不生成解说、语音或弹幕。

## 下一步验收

1. 补全生产采集装配、原始包去重与真实 `ResSyncGame` 完整映射，并采集可独立复核的完整脱敏回放。
2. 验明规则／自动和牌读回、单步截止时间与源游标跨小局语义；完成桥接请求号分配、待入站消息及最终发送点的跨进程栅栏。
3. 在授权的机器人友人房用正式 Actor／存储／执行器复测弃牌、暂停和重连，关键字段与客户端逐项一致后才计入阶段 1 实场验收。

阶段 2 的完整动作、引擎规则／候选映射、LLM／本地规则与双模式整场，以及阶段 0 的 OBS、B站和模型许可缺口仍按实施计划推进。
