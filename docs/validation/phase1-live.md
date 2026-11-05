# 阶段 1：生产桥接与实场验收

[文档导航](../README.md) · [状态基础](./state-foundation.md) · [运行说明](../USAGE.md)

2026-11-05（Asia/Shanghai），当前 Mac arm64、Node 24.22.1、雀魂 Unity WebGL 4.0.51。正式 Actor、SQLite worker、执行器和浏览器桥接已通过**普通弃牌、重连同步、发送前暂停**的实场验收。倒计时和自动和牌仍由操作人读回；持续自动运行保持关闭。这是阶段 1 的普通弃牌范围验收，不覆盖阶段 2 的完整动作、双模式或整场。

## 实场结果

| 验收 | 当前客户端证据 | 结果 |
| --- | --- | --- |
| 房型 | 同一友人房，四人东风、300＋0 秒、三席电脑；页面与认证响应 category=1、mode=1、ai=true、time_fixed=300/time_add=0 一致 | 通过；入口再次核对服务端房型 |
| 请求号 | 新连接自首帧统一分配 wire ID；Unity 回执恢复客户端原 ID，桥接回执独立处理；真实心跳、认证及 syncGame 正常 | 通过；安装前的旧连接禁止程序发送 |
| 完整恢复 | 历史 step 0 是 ActionMJStart，step 1 是 ActionNewRound；恢复 0—9 共 10 条动作，next-step=10；自手、牌河、seat 1 公开碰、剩余 66 张与画面一致 | 通过；未用 snapshot 摘要替代历史 |
| 正式弃牌 | 21:33:50，普通窗口 step 9；先冻结决策并持久化 dispatching，再经一次性许可发送 4s 摸切；wire requestId=34 得到 accepted，随后 seat 0 / step 10 / ActionDiscardTile(4s, moqie=true) | confirmed；一个程序发送，一个权威确认 |
| 重连 | 页面重载后捕获新连接，再同步到 step 17（next-step=18）；同一 game UUID 和开局摘要得到相同 gameMatchKey/gameHandKey，旧命令未重发 | 通过；每次重新建立执行代际 |
| 最终发送前暂停 | 21:37:48，在真实 dispatching 和页面 prepare 后暂停并等待远端撤销，再调用旧许可 | not-sent / not-dispatched；bridgeActionSends 0→0，确认数 0 |
| 自动和牌 | 点击“和”后由灰变绿；重载后实测恢复为关闭，再次开启并读回 | 单次视觉读回通过；不能假设跨重连保持 |
| 清理接管 | 页面 paused，pendingRpcCount=0；恢复原 WebSocket/send，移除监听和探针，保留页面交还用户 | 通过 |

本机原始报告位于忽略的 `data/validation/phase1-live-once-2/report.json` 和 `data/validation/phase1-live-pause/report.json`，共用 `data/live/state.sqlite`。真实房号在提交资产中用别名替代，game UUID 仅保留摘要；不提交截图中的账号显示或原始协议响应。

## 可独立重放的实场资产

[`phase1-live-discard`](../../tests/fixtures/phase1-live-discard/manifest.json) 保存 12 条严格领域事件：完整当前手历史和确认的程序弃牌，包含对手公开碰牌、两次己方弃牌事实。第一条己方 7z 弃牌发生在服务器超时后，属于历史事实；第二条 4s 摸切有正式程序确认，不能把两条都算作程序发送。

资产为 `live-capture`，源版本 `majsoul-4.0.51/proto-1c332959d97f`。事件 canonical SHA-256：`b64eb9f2ccf53a295d3cca3b20a4dca753989f02cde7b4d2bdd62bca544df8a0`；最终状态 SHA-256：`4c8aa1f95062ebb98ec3acbdc74c52ca946dc595d8316ef397f77b3ea416310c`。重放得到序号 12、唯一己方弃牌事实 2，哈希相符。

最终 `vfox exec nodejs@24.22.1 -- npm run verify`：TypeScript 检查通过，107 项 Node 测试（含子测试）全部通过，无跳过／失败；CLI 实场资产重放也单独通过。未改 Rust runner，本轮没有重新声称 Rust 或整场自动对局验收。[机器可读实场摘要](./phase1-live-evidence.json)仅保存白名单结果与资产摘要。

归档重建连接代际，不保存可复活的操作窗口或许可。正式库中的确认仍为 `live`；离线重放只证明事实归约，不能再次生成游戏操作。

## 本轮修复的实场差异

- 当前客户端为 Unity WebGL，没有 JavaScript NetAgent。生产桥接通过统一 wire 请求号分配处理并发，不使用阶段 0 的 60000 私有号。
- 同步历史可有 ActionMJStart 前缀；live bytes 先 XOR，restore bytes 直接 protobuf 解码。
- 庄家开局 14 张牌的数组没有可依赖的“最后一张摸牌”语义。开局 drawnTileRef 为已知 null，首弃不开放程序窗口；下一次独立 ActionDealTile 后才构造普通弃牌候选。
- ego 的 Node helper 在创建 worker_threads 时退出；正式 Actor／SQLite 改在项目固定 Node 子进程中运行，ego 通过有界、白名单 JSONL 通道操作页面。测试覆盖真实子进程及 SQLite worker。
- 新运行默认复用固定 live 台账。旧 uncertain 动作阻止新 session/process 提交；新建报告目录不清空未决动作。

## 保留的门槛

单步期限来自截图读回的客户端剩余时间，减去经过时间并预留 5 秒不确定量；页面许可另以 performance.now 锚定，最长 1 秒，人工读回预算最长 30 秒。房间的 300 秒设置不直接充当单步截止。没有建立无人值守可用的倒计时采集来源或 near-deadline 时延保证。

暗／加杠、和／流局及结束状态同步、非普通弃牌窗口仍拒绝执行。新小局与整场连续运行协调、完整规则映射、自动和牌实际触发和自动读回属于后续工作；不以此次单步验收代替。故障注入的崩溃／迟到／丢确认场景为契约或存储测试，未在真实服务器上全部重演。

当前资产导出要求本次归档的 handOrdinal=1，且没有己方鸣牌消耗引用；不满足时拒绝导出。所有权威操作仍经过单执行器；不确定回执先关闸、保留原台账并同步对账，禁止靠换数据库重试。
