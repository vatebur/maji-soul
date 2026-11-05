# 阶段 2 动作映射：离线实现与实场门槛

2026-11-05（Asia/Shanghai）。本批实现吃、碰、明杠、暗杠、加杠和立直弃牌的候选、协议选择、事实归约与台账确认。证据为合成契约测试；尚未完成当前 Unity 客户端各分支及真实整场验收，阶段 2 页面发送默认关闭。

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

相同普通牌的消费使用稳定实例排序，绝不把红五当普通五。多个组合索引映射到同一语义、红牌不符、错误上家、旧碰引用、不存在的自手牌、未知操作及变体字段均拒绝。吃碰后的弃牌允许已知 `drawnTileRef=null`，并保留食替限制；杠后必须等待补牌才开放弃牌窗口。

台账继续使用原 `state.sqlite`。新 intent 在 JSON body 保存完整 `actionSpec` 和可跨重连比较的 `expectedAction`；原表结构及旧普通弃牌行兼容，不新建数据库。弃牌确认同时比较立直声明，鸣牌确认比较完整牌集合、来源、被叫牌和升级引用。RPC accepted 不等于 confirmed；只有同场、同小局、预期来源游标的权威事实才能确认，准备期间的手动动作不能提前确认程序发送。

完整同步归档鸣牌事实，并从完整历史的最后权威弃牌重建当前反应来源，重键自手消费引用。仅有摘要或旧历史弃牌不能复活吃碰许可。

验证：`tests/phase2-actions.test.ts` 覆盖各动作、红牌、组合索引篡改与歧义、食替、立直负例、序列化页面规则、加杠升级、补牌、重连引用与 SQLite worker 确认。旧 reducer、normalizer、storage、executor、sync 测试同时保留。实场仍需逐项记录每种动作的实际操作列表、所选组合索引、一次发送及唯一权威确认；自动和牌优先权与旧许可失效也必须在当前客户端复测。

协议字段来自本机固定提取的 `liqi.proto`；动作枚举与组合形状交叉参考维护者的 [Naki Unity 协议说明](https://github.com/Sunalamye/Naki/blob/main/docs/majsoul-unity-protocol.md)、[mahjong-helper 的实际消息样例](https://github.com/EndlessCheng/mahjong-helper/blob/master/majsoul.go)及 [majsoul-helper 的组合选择代码](https://github.com/jlower/majsoul-helper/blob/main/action.py)。这些上游材料提供实现依据，不替代本项目的当前客户端实测。

本批不提供连续策略、两种模型整场验收或小局协调，也不将可选动作的 pass 推断为已确认的程序发送。
