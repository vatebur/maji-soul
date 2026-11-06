# 阶段 2 动作映射：离线实现与实场门槛

2026-11-05（Asia/Shanghai），2026-11-06 补充 type 7 修复与实场解析证据。本批实现吃、碰、明杠、暗杠、加杠和立直弃牌的候选、协议选择、事实归约与台账确认。实现验证以合成契约测试为主，另有下述立直列表的真实解析记录；尚未完成当前 Unity 客户端各分支及真实整场验收，阶段 2 页面发送默认关闭。

`OptionalOperationList` 是候选的权威来源。服务端组合的原始顺序、`type`、`index` 和 `combination` 随动作保存；发送前使用同一份 `createOperationRules`，从当前操作列表重新推导，要求动作规格完全匹配。模型不能填写任意索引或把牌种替换成另一张物理牌。

| 操作 | type | 组合语义 | 请求 |
| --- | --- | --- | --- |
| 普通弃牌 | 1 | `combination` 中列出的牌为食替限制，排除同牌种的全部实例 | `inputOperation(type=1,tile,moqie)` |
| 吃／碰 | 2／3 | 两张精确自手牌，与最新他家弃牌组成副露 | `inputChiPengGang(type,index)` |
| 暗杠 | 4 | 四张精确自手牌 | `inputOperation(type=4,index)` |
| 明杠 | 5 | 三张精确自手牌，与最新他家弃牌组成副露 | `inputChiPengGang(type=5,index)` |
| 加杠 | 6 | 组合指定已有碰的三张牌，唯一确定第四张自手牌及被升级的碰 | `inputOperation(type=6,index)` |
| 立直弃牌 | 7 | 组合列出可声明立直的精确弃牌；红五与普通五分别匹配 | `inputOperation(type=7,tile,moqie)` |
| 自摸／荣和 | 8／9 | 独占 `client-auto-win` 窗口，屏蔽全部程序候选 | 程序禁止发送 |

相同普通牌的消费使用稳定实例排序，绝不把红五当普通五。吃、碰及各类杠中，多个组合索引映射到同一语义仍拒绝；普通弃牌（type 1）的重复组合也仍拒绝。红牌不符、错误上家、旧碰引用、不存在的自手牌、未知操作及变体字段均拒绝。吃碰后的弃牌允许已知 `drawnTileRef=null`，并保留食替限制；杠后必须等待补牌才开放弃牌窗口。

`52fb65c` 对立直弃牌（type 7）增加了一个限定例外：允许列表重复出现完全相同的单牌字符串，保留原数组及顺序，不全局去重或重排索引。每张符合列表的物理自手牌只生成一个立直候选，同牌的不同实例仍各有唯一候选；红五与普通五分别匹配，是否摸切由该实例与 `drawnTileRef` 的关系确定。候选保存该精确牌码在原列表中首次出现的 `index` 及对应 `combination`，作为重新推导合法动作时的校验依据（witness）；改成后续重复条目的索引仍会被拒绝。最终请求为 `inputOperation(type=7,tile,moqie,timeuse=0)`，按 `tile` 与 `moqie` 选择弃牌，不发送 `index`。其它动作的歧义限制不变。

台账继续使用原 `state.sqlite`。新 intent 在 JSON body 保存完整 `actionSpec` 和可跨重连比较的 `expectedAction`；原表结构及旧普通弃牌行兼容，不新建数据库。弃牌确认同时比较立直声明，鸣牌确认比较完整牌集合、来源、被叫牌和升级引用。RPC accepted 不等于 confirmed；只有同场、同小局、预期来源游标的权威事实才能确认，准备期间的手动动作不能提前确认程序发送。

完整同步归档鸣牌事实，并从完整历史的最后权威弃牌重建当前反应来源，重键自手消费引用。仅有摘要或旧历史弃牌不能复活吃碰许可。

验证：`tests/phase2-actions.test.ts` 覆盖各动作、红牌、组合索引篡改与歧义、食替、立直负例、序列化页面规则、加杠升级、补牌、重连引用与 SQLite worker 确认。旧 reducer、normalizer、storage、executor、sync 测试同时保留。实场仍需逐项记录每种动作的实际操作列表、所选组合索引或立直物理牌候选、一次发送及唯一权威确认；自动和牌优先权与旧许可失效也必须在当前客户端复测。

[2026-11-06 证据摘要](./automation-live-20261106-evidence.json)第 27 条（run 27）已记录真实重复立直列表：step 95 的 4 个条目涉及 2 种牌值，正常入账为 3 个不同物理牌候选，未再触发此前的歧义解析错误。随后 root 通过 UI 选择立直，step 96 权威事实确认为手切 `7p`。这段验证支持真实列表解析与候选归一化；该立直没有经过主执行器派发，`productionRiichiDispatchTested=false`，不能计作主执行器立直发送覆盖或阶段 2 完整动作验收。

协议字段来自本机固定提取的 `liqi.proto`；动作枚举与组合形状交叉参考维护者的 [Naki Unity 协议说明](https://github.com/Sunalamye/Naki/blob/main/docs/majsoul-unity-protocol.md)、[mahjong-helper 的实际消息样例](https://github.com/EndlessCheng/mahjong-helper/blob/master/majsoul.go)及 [majsoul-helper 的组合选择代码](https://github.com/jlower/majsoul-helper/blob/main/action.py)。这些上游材料提供实现依据，不替代本项目的当前客户端实测。

本批不提供连续策略、两种模型整场验收或小局协调，也不将可选动作的 pass 推断为已确认的程序发送。
