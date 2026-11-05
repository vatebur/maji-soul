# 暂停、同步与动作恢复验证

[文档导航](../README.md) · [阶段 1 范围](./state-foundation.md)

2026-11-05。本页主体记录真实 Node worker／SQLite 上的合成事件与受控 Promise 时序，假传输不访问雀魂。后续已补充[生产桥接实场验收](./phase1-live.md)：真实 dispatching／prepare 后暂停，旧许可返回 not-sent，动作发送计数 0→0。故障表的其他场景仍按各自证据类型理解。

| 场景 | 验证结果 |
| --- | --- |
| 事件落库等待 | 内存投影不提前推进；提交成功后才发布新状态 |
| 同事件重复／同源键内容冲突 | 重复不增加版本或 outbox；冲突关闭执行 |
| 漏步、乱序、邮箱溢出、未知状态 | 关闭执行，必须同步；后续普通事件不能自动洗成可信 |
| 冻结落库中暂停 | 记录可保留，迟到快照不能进入候选注册表 |
| 认领／发送意图落库中暂停 | 最终许可失败，记录 not-dispatched，假传输调用为 0 |
| 桥接准备中暂停／新入站事实 | 发送前重新检查；旧许可不能使用 |
| 准备期间人工打同一张牌 | 仅归档事实；明确未发送不能被匹配成程序确认 |
| 权威事实早于发送回执 | 先归档，回执允许后在事务中匹配；accepted 本身不等于成功 |
| 调用抛错／回执超时 | 可能已发送时保留 uncertain 并关闸；不自动重试 |
| 迟到回执 | 不覆盖已确认结果；不把 uncertain 降回可重发状态 |
| 进程重启 | 新 processInstanceId，旧 writer 写入失败；旧检查点只供同步依据，不恢复执行许可 |
| 仅 prepared 时崩溃 | 因未写入 dispatching，证明未发送，恢复为 not-dispatched；仍须同步且不释放原程序槽位 |
| dispatching／awaiting 时崩溃 | 恢复 uncertain，先对账，不从旧快照补发 |
| 完整当前状态但无匹配历史 | 可以重建状态，未决动作继续阻止恢复执行；窗口消失不能证明成功 |
| 精确同步事实 | 同整场／小局、源游标、座位、牌和摸切一致，并与当前河牌／完整历史交叉核验后才确认 |
| 同局重连／连庄新手 | 同局保留 activeMode 并换代际牌引用；新手分配新 handId、采纳 pendingMode、清上下文 |
| 时钟回拨／许可过期 | 进程内单调预算不延长；未知截止时间不能冻结或执行 |
| 预演／只读检查 | simulated 无发送与确认，不占程序槽位；inspect 不接管会话、不修改恢复状态 |

修复的关键竞态：持久化 `dispatching` 只证明准备发送，不能证明已经发生发送。此前若准备期间人工恰好打出同牌，便会过早确认。现在该阶段只归档动作事实，随后 `sent`／`accepted`／`unknown` 才允许精确对账；`not-sent`／`rejected` 不借用该事实。崩溃后确实可能已经发送的记录仍按 uncertain 处理。

测试入口为 [`actor.test.ts`](../../tests/actor.test.ts)、[`execution.test.ts`](../../tests/execution.test.ts)、[`storage.test.ts`](../../tests/storage.test.ts)、[`browser-bridge.test.ts`](../../tests/browser-bridge.test.ts) 和 [`live-broker.test.ts`](../../tests/live-broker.test.ts)。远端控制屏障有界超时且失败关闸；共享 live 台账防止新运行绕过旧 uncertain 动作。真实跨进程最终暂停与当前完整同步已有实场证据，丢确认／崩溃／罕见动作的全部实场组合尚未覆盖。

后续批次已补[跨小局与恢复协调](./lifecycle-coordination.md)：结束／连庄／终局状态、同库跨 session 的历史与结算校验、prepared 后及 prepare 等待中的旧动作撤销、认证等待和终局恢复。相关测试在 `coordinator.test.ts`、`hand-lifecycle.test.ts` 和 `live-lifecycle.test.ts`；均为契约／故障注入证据，未扩大原实场验收范围。
