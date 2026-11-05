# AI 雀魂直播：开源项目调研

[文档导航](../README.md) · 调研

调研日期：2026-11-05，Asia/Shanghai。研究范围包括用户指定的六个麻将项目、DSH 直播插件，以及后来补充的弹幕／TTS／虚拟主播项目。

后续实现补充：已开展新工程阶段 0，重新运行固定 Akagi、当前客户端与模型／语音探测；实测范围见[技术验证记录](../validation/technical-spikes.md)，实际采用版本和许可见[UPSTREAM.md](./UPSTREAM.md)。下文保留原调研及旧原型的历史含义，不将其追认为新工程验收证据。

本文依据公开仓库、固定版本源码和官方文档。除“旧原型的历史验证”一节外，没有安装或运行这些上游项目，也没有实际连接直播间、发送弹幕或推流。Star 是查询时的快照；更新日期优先使用默认分支最新提交，而非 `pushed_at`。

同日补充：[Live2D 调研与接入设计](./LIVE2D.md) 重新核查了配套前端、音频／表情消息、AIRI 组件和官方 Live2D／OBS 资料，并修正下文对 Open-LLM-VTuber 许可的概括。其余项目的版本、Star 与历史实测范围保持原调研含义。

旧代码和调试产物已按用户要求清理，后续重新实现。当前需求基线见 [PLAN.md](../planning/PLAN.md)，据此形成的程序模型与架构分别见 [DOMAIN_MODEL.md](../design/DOMAIN_MODEL.md)、[ARCHITECTURE.md](../design/ARCHITECTURE.md)。

## 目录

- [结论与复用方向](#结论与复用方向)
- [六个麻将项目](#六个麻将项目)
- [直播／TTS 项目对照](#直播tts-项目对照)
- [原先指定的 DSH 插件](#原先指定的-dsh-插件)
- [本机与旧原型的历史验证](#本机与旧原型的历史验证)
- [实施前的验证顺序](#实施前的验证顺序)

## 结论与复用方向

建议新建独立的 Node.js／TypeScript 主程序：游戏状态、AI 模式和动作执行由它统一管理。专用麻将引擎优先评估 Akagi v3 的 `native_bot`；讲解采用 Majsoul Agent 的“冻结当前决策，再依据证据解释”设计。直播侧参考现成的弹幕适配、TTS 和字幕组件，首版使用本机中文语音。

Live2D 优先复用 Open-LLM-VTuber 的角色前端；AIRI 的渲染与口型组件作为备选。它们作为可替换的直播输出端，不拥有麻将动作的执行权；本项目保留内容审查、调度与唯一音频播放权。具体复用方法、版本组合、回执改造和 OBS 验收见专题。这是结合源码和本项目约束作出的工程判断，并非已经完成的兼容性验证。

“读取直播内容”需要区分三条能力：

| 能力 | 可以知道什么 | 本项目使用方式 |
| --- | --- | --- |
| 弹幕输入 | 观众说了什么、是谁提问 | B站消息接收器提供事件和可用身份 |
| 截图／视觉模型 | 屏幕大致发生了什么 | 可选的画面语境补充；效果取决于视觉模型 |
| 结构化对局输入 | 手牌、牌河、宝牌指示牌、分数、操作候选、实际执行结果 | 麻将讲解的主要事实来源，由游戏程序输出 |

下面发现的截图能力均不能直接等同于稳定的日麻牌面解码、逐手事件识别或持续理解 B站音视频直播流。

## 六个麻将项目

| 项目 | Star | 创建 → 最新提交 | 已核实的优势 | 对本项目的限制／建议 |
| --- | ---: | --- | --- | --- |
| [Akagi](https://github.com/shinkuan/Akagi) | 1,125 | 2024-01 → 2026-11-05 | v3 有本地 CPU 麻将模型、云推理、mjai 插件、Unity 协议工具、自动操作及独立牌理分析 | 首选研究引擎和分析模块；完整桌面程序没有现成 headless HTTP 控制接口；自动建房和连续开局仍由本项目负责 |
| [Majsoul Agent](https://github.com/oreki-L/majsoul-ai-analysis-and-review-agent) | 1 | 2026-10 → 2026-11-05 | 冻结决策快照、引擎结果与通用 LLM 解释分离、围绕某一手追问 | 不自动打牌；当前本地便携模型包以 Windows 为主，不能直接当 Mac 引擎；最适合借鉴解释契约 |
| [mahjong-jev-advisor](https://github.com/PaoPao1021/mahjong-jev-advisor) | 5 | 2026-09 → 2026-10-21 | 本地规则候选、Jev／OpenAI 兼容模型、中文分析、状态恢复、Mac arm64 发布包 | 不自动操作；不是自带已验证牌力的训练模型；本地 HTTP 端口主要接收采集数据，不是现成对外讲解服务 |
| [Akagi-NG](https://github.com/Xe-Persistent/Akagi-NG) | 81 | 2025-12 → 2026-11-01 | Electron、Rust 本地三／四麻引擎、Mac arm64、在线推理 | README 明确不提供自动操作；引擎可封装，但不是已发布的独立 npm 推理服务 |
| [MahjongCopilot](https://github.com/latorc/MahjongCopilot) | 1,097 | 2024-03 → 2025-03-23 | Mortal 等模型、自动操作、Q 值／合法掩码等输出 | 旧页面对象耦合较多，存在 Windows 专用启动代码；当前 Unity 与 Mac 的完整兼容性没有证据，不作为新项目主底座 |
| [AlphaJong](https://github.com/Jimboom7/AlphaJong) | 445 | 2019-08 → 2024-11-04 | 真正的用户脚本；自动操作／提示；向听、进张、风险等启发式分析 | 是传统算法，不是外接训练 AI；依赖旧 `DesktopMgr`／Laya 对象，当前 Unity 需要改造，适合参考本地规则 |

### Akagi 的可复用边界

固定版本为 [`63cea4b`](https://github.com/shinkuan/Akagi/commit/63cea4b5d23d83bbee8d56bc3b9d547cca2046c3)。`native_bot` 是 Rust 库，采用 CPU 推理，可接收 mjai 事件并输出动作、候选和 logits。其模型是行为克隆 CNN，不能直接宣传为 Mortal 或用有限场次证明牌力。[引擎代码](https://github.com/shinkuan/Akagi/blob/63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/native_bot/src/engine.rs)、[依赖与库声明](https://github.com/shinkuan/Akagi/blob/63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/native_bot/Cargo.toml)

需要自己封装输入／输出进程协议，并完成雀魂到 mjai 的事件和动作映射。默认展示前三个候选；源码只为首选立直动作补上具体弃牌，其他立直候选可能没有完整参数。用于程序决策前，必须补全参数并映射为当前合法动作。

Akagi 的向听、进张、得点和危险度来自独立分析模块。模型 softmax 表示其动作偏好，并不等于和牌率；独立分析也不是模型内部“思考过程”。直播应分别标注事实、模型推荐和分析估计。[分析结果类型](https://github.com/shinkuan/Akagi/blob/63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/src/analysis/result.rs)

自动操作采用 CDP 页面输入，有真实实现，但不能与本项目执行器同时控制一个牌局。当前上游协议资料以 4.0.47 为一项版本证据；不能据此声称完整支持本机观察到的 4.0.51。[自动操作](https://github.com/shinkuan/Akagi/blob/63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/src/autoplay/majsoul/mod.rs)、[输入实现](https://github.com/shinkuan/Akagi/blob/63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/src/autoplay/cdp_input.rs)

### 解释与追问的参考

Majsoul Agent 将原始决策固定下来，再请求 `{summary, reasons, limitations}`；解释接口拒绝让 LLM 通过返回新牌张或动作改变原决策。这适合直播回答“刚才为什么打那张”。其候选映射尚有明确空缺，不能承诺完整 Q 值或候选概率输出。[解释契约](https://github.com/oreki-L/majsoul-ai-analysis-and-review-agent/blob/5a490a1e77b81c8ee54d4b7f30e971b3bac761db/extension/contracts/engine-explanation.js)、[引擎结果契约](https://github.com/oreki-L/majsoul-ai-analysis-and-review-agent/blob/5a490a1e77b81c8ee54d4b7f30e971b3bac761db/extension/contracts/engine-result.js)、[功能审计](https://github.com/oreki-L/majsoul-ai-analysis-and-review-agent/blob/5a490a1e77b81c8ee54d4b7f30e971b3bac761db/docs/development/FEATURE_AUDIT.md)

Jev 项目的候选中含向听、进张、危险度、宝牌损失等字段；在线 Jev 返回的候选概率也不能当成和牌率。[规则候选](https://github.com/PaoPao1021/mahjong-jev-advisor/blob/2efd5fd5846a678e7b632d9309fdca902c1e084d/src/mahjong_jev_advisor/rules.py)、[在线选择](https://github.com/PaoPao1021/mahjong-jev-advisor/blob/2efd5fd5846a678e7b632d9309fdca902c1e084d/src/mahjong_jev_advisor/jev.py)

其余项目核查入口：[Akagi-NG 引擎接口](https://github.com/Xe-Persistent/Akagi-NG/blob/41661ca81e5f400e88398300f0b749d04c91d2ed/packages/rust_engine/native/index.d.ts)、[MahjongCopilot 页面依赖](https://github.com/latorc/MahjongCopilot/blob/31be3de972bbe4b1261360ff61b18f1bb84babbe/game/browser.py)、[AlphaJong 页面 API](https://github.com/Jimboom7/AlphaJong/blob/a868e1654decb9374081c72117b008beccfa0eaa/src/api.js)。

## 直播／TTS 项目对照

| 项目 | Star／最新提交 | 弹幕、内容和语音能力 | 对当前 Mac 项目的适用性 |
| --- | --- | --- | --- |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 14,592／2026-05-15 | B站收弹幕、多种 TTS、角色人设、Live2D、字幕、截图输入、外部 WS | 最值得验证的完整角色前端；官方 B站模块不回发文字；需替换默认排队策略 |
| [AI-Vtuber／Luna AI](https://github.com/Ikaros-521/AI-Vtuber) | 4,583／2026-10-31 | B站弹幕、丰富 TTS、禁词、人设、字幕、HTTP 文本入口、语音优先级 | 直播功能参考最全；文字发送依赖额外助手，Mac 截屏及本机 `say` 需补，当前 CI 未通过 |
| [AIRI](https://github.com/moeru-ai/airi) | 51,117／2026-11-05 | 角色、语音、截图视觉、上下文事件 SDK、Mac arm64 包 | 值得探索视觉和角色表现；仓库 B站插件仍是 `console.warn('WIP')`，需另外接弹幕收发 |
| [LiveLink](https://github.com/Mr-Salticidae/livelink) | 9／2026-08-24 | B站消息、Edge TTS、AI 口播、OBS 页面和观众互动 | 可参考 OBS 页面与语音接入；发行和打包针对 Windows，AI 回复链只到日志／语音，不能当文字回弹幕闭环 |
| [blivechat-tts（TypeScript）](https://github.com/AoEiuV020/blivechat-tts) | 0／2025-11-15 | 从 blivechat 取弹幕，调用系统 TTS 朗读 | 最贴近本机语音起步，代码很小；没有 LLM 解释、画面理解、回弹幕或麻将接口 |
| [ZerolanLiveRobot](https://github.com/AkagawaTsurunaki/ZerolanLiveRobot) | 828／2026-01-17 | B站消息、角色、GPT-SoVITS／百度 TTS、OCR、OBS 字幕 | 外部游戏事件入口、文字发送、Mac 设备适配和播报调度均需开发，不作为首选整套依赖 |
| [muvtuber](https://github.com/cdfmlr/muvtuber) | 507／2024-08-27 | B站输入、LLM、Azure TTS、HTTP 输入、OBS 音频与 Live2D 页面 | 模块边界清晰，可参考 OBS 音频输出；多服务部署较重，维护时间较早 |

### Open-LLM-VTuber：角色前端候选

固定后端 [`992309c`](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/commit/992309c0aa19845960228f880013d4685fde93b5)。官方 B站接收器把弹幕正文转为 `text-input`，没有保留完整观众身份；`send_message()` 明确不支持发回直播间。[B站适配器](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/src/open_llm_vtuber/live/bilibili_live.py)

`/client-ws`、`/proxy-ws` 可输入文本和图片；`/tts-ws` 可将已经生成的解说直接转成音频路径。后者不会自动触发 Live2D／OBS 播放，需要输出适配器。[路由](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/src/open_llm_vtuber/routes.py)

默认代理队列是 FIFO，下一条对话等待前端确认当前语音播放完成。外部程序如果只连接 WebSocket 却不发播放完成确认，会阻塞后续对话。已有截图和多模态模型链路，但不等同于持续理解直播流。[队列](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/src/open_llm_vtuber/proxy_message_queue.py)、[播放结束等待](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/src/open_llm_vtuber/conversations/conversation_utils.py)、[截图实现](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web/blob/3d57a9a0125a0ca13e5d096f7092e4e494ed389e/src/renderer/src/hooks/utils/use-media-capture.tsx)

项目有 Mac arm64 依赖／打包依据，但包含 Python、FFmpeg、Torch／ONNX 等依赖；仅为系统 TTS 引入整套项目偏重。后端该版本为 MIT；配套前端源码 `3d57a9a` 使用带附加条件的 Open-LLM-VTuber License 1.0，Cubism Core 和示例角色模型又有独立许可。原先“代码为 MIT”的概括不适用于整套项目。[依赖](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/pyproject.toml)、[后端许可证](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/LICENSE)、[前端许可证](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web/blob/3d57a9a0125a0ca13e5d096f7092e4e494ed389e/LICENSE)

本轮进一步发现：前端的会话级完成通知没有逐条 speechId，错误和正常结束的任务都会结束等待；“开始”通知也早于实际音频播放。不能直接据此确认本项目语音交付。源码证据、改造和模型动作映射详见 [Live2D 专题](./LIVE2D.md)。

### AI-Vtuber：功能完整，但需要适配

固定版本 [`c430ee7`](https://github.com/Ikaros-521/AI-Vtuber/commit/c430ee71f208f45850c1ab25c85f2a70e9b09d72)。外部接口有 `/send`、`/llm`、`/tts`；可以投递聊天或直接朗读文本。`/tts` 返回合成路径，不负责播音。向直播间发文字的链路依赖外部“洛曦直播弹幕助手”。[API](https://github.com/Ikaros-521/AI-Vtuber/blob/c430ee71f208f45850c1ab25c85f2a70e9b09d72/app/api.py)、[文字转发](https://github.com/Ikaros-521/AI-Vtuber/blob/c430ee71f208f45850c1ab25c85f2a70e9b09d72/luna/platforms/luoxi/live_comment_assistant.py)

已有禁词、可配置人设、合成／播放优先级队列，但 `/send` 的直接朗读默认绕过禁词；没有麻将决策过期机制。默认直接朗读优先级还高于观众评论，需要调整以符合聊天优先。[直接朗读处理](https://github.com/Ikaros-521/AI-Vtuber/blob/c430ee71f208f45850c1ab25c85f2a70e9b09d72/luna/core/my_handle.py)、[音频队列](https://github.com/Ikaros-521/AI-Vtuber/blob/c430ee71f208f45850c1ab25c85f2a70e9b09d72/luna/audio/service.py)

截窗代码只支持 Windows，当前 TTS 注册表没有 macOS 系统 `say`。该提交 CI 在安装开发依赖时失败，不能宣称当前版本通过了测试；这也不证明核心运行必定失败。[截窗代码](https://github.com/Ikaros-521/AI-Vtuber/blob/c430ee71f208f45850c1ab25c85f2a70e9b09d72/luna/common/screen.py)、[CI 记录](https://github.com/Ikaros-521/AI-Vtuber/actions/runs/41216748438/job/124582753507)

仓库 LICENSE 是 GPL-3.0，README 同时另写商用联系授权／抽成说明；在分发改造版本前需厘清相应声明。这里记录仓库原文状态，不作进一步法律推断。

### AIRI：视觉与角色探索方向

当前官方仓库为 `moeru-ai/airi`，审查版本 [`e20d734`](https://github.com/moeru-ai/airi/commit/e20d7346bb74862646d739a775d2d28628792d98)。有 Mac arm64 发布链接、多种语音提供方、截屏及视觉描述代码；其 SDK 支持 `input:text`、`context:update`，适合新写麻将上下文适配器。[README](https://github.com/moeru-ai/airi/blob/e20d7346bb74862646d739a775d2d28628792d98/README.md)、[SDK](https://github.com/moeru-ai/airi/blob/e20d7346bb74862646d739a775d2d28628792d98/packages/server-sdk/README.md)、[事件协议](https://github.com/moeru-ai/airi/blob/e20d7346bb74862646d739a775d2d28628792d98/packages/plugin-protocol/src/types/events.ts)、[视觉推理](https://github.com/moeru-ai/airi/blob/e20d7346bb74862646d739a775d2d28628792d98/packages/stage-ui/src/composables/vision/use-vision-inference.ts)

其 `airi-plugin-bilibili-laplace/src/index.ts` 只有 `console.warn('WIP')`，不能把插件目录存在当作弹幕已接通。协议类型中的优先级／TTL 也不能单独证明已具备本项目所需的完整直播调度。[B站插件入口](https://github.com/moeru-ai/airi/blob/e20d7346bb74862646d739a775d2d28628792d98/plugins/airi-plugin-bilibili-laplace/src/index.ts)

### LiveLink 与 blivechat-tts：界面和轻量语音参考

LiveLink 固定版本 [`0d55424`](https://github.com/Mr-Salticidae/livelink/commit/0d554240c0906afeb74cde41455194c42a113f16) 已有 OBS 页面和 TTS。AI 回复实现只写日志和加入语音队列，没有 B站文字发送。[AI 回复](https://github.com/Mr-Salticidae/livelink/blob/0d554240c0906afeb74cde41455194c42a113f16/src/main/services/ai-reply.ts)

其打包脚本明确 `--win`；README 和 package 声明 MIT，但本次根目录未找到对应 LICENSE，引用代码前要补齐许可核对。[package](https://github.com/Mr-Salticidae/livelink/blob/0d554240c0906afeb74cde41455194c42a113f16/package.json)

`AoEiuV020/blivechat-tts` 的 [实际 TTS 代码](https://github.com/AoEiuV020/blivechat-tts/blob/23c24c6e9d683150830d44db218e8adb7e45345c/src/tts.ts) 调用 Node `say`，弹幕消费者直接念用户名与内容，没有 LLM 或禁词流程。它适合学习如何接系统语音，不能作为完整 AI 主播交付。根许可元数据和 package 的许可字段不一致，复用前按实际文件核对。

另有作者本人提供的 [xfgryujk/blivechat-tts](https://github.com/xfgryujk/blivechat-tts)，README 明确定位为消息转发演示，不打算打包成用户产品，Mac 尚未测试。[blivechat](https://github.com/xfgryujk/blivechat) 本身提供 OBS 弹幕展示与插件系统，可作为另一种弹幕输入来源。

### 其他候选

Zerolan 的 B站服务只收消息，外部 HTTP 没有通用游戏事件入口；默认 LLM→TTS 逐条处理，缺少优先级和旧局面淘汰。Mac 被走入 Linux 屏幕路径，必须改造。指定 GPT-SoVITS fork 本身有 Apple silicon 文档，这与机器人整体 Mac 适配是两件事。[机器人](https://github.com/AkagawaTsurunaki/ZerolanLiveRobot/blob/aad29d093295eef351da03a0bbe6ffac5539716d/bot.py)、[平台屏幕选择](https://github.com/AkagawaTsurunaki/ZerolanLiveRobot/blob/aad29d093295eef351da03a0bbe6ffac5539716d/devices/screen/base_screen.py)、[TTS fork](https://github.com/AkagawaTsurunaki/GPT-SoVITS/blob/7706224f4835ee8e9516e454cc385db8c81d961b/README.md)

muvtuber 有 `{author, content, priority}` HTTP 输入和明确的 OBS 浏览器音频方案，适合参考服务分工；当前锁定的 TTS 子模块是 Azure，不能根据旧开发说明声称仍自带 Mac 系统语音。[项目说明](https://github.com/cdfmlr/muvtuber/blob/c065f4c93b6b03173dd04d454a217aa8c529a613/README.md)、[输入接口](https://github.com/cdfmlr/muvtuberdriver/blob/5fe057d4bf48d6300dfc88a26a390a892390a415/http.go)

## 原先指定的 DSH 插件

[`newmegame/-dsh-bili-live`](https://github.com/newmegame/-dsh-bili-live) 是 DeepSeek Harness 插件，依赖宿主提供 UI、LLM 和 Web 服务。它已有 B站收／发弹幕、禁词、风格、回复节流；没有 TTS、OBS 对局画面或麻将上下文入口。用户现已选择独立程序，因此不再把 DSH 作为运行依赖。

固定版本 [`0e7a393`](https://github.com/newmegame/-dsh-bili-live/commit/0e7a393c10007d392ba733c902579876574e2e1b) 的 `lib/bili.js` 相对独立，提供事件接收和发送方法，值得评估组件级复用。仍需验证当前 B站连接和身份字段。[B站实现](https://github.com/newmegame/-dsh-bili-live/blob/0e7a393c10007d392ba733c902579876574e2e1b/lib/bili.js)

两个不能直接照搬的行为：它的 SSE 是最近约 40 条消息的合并快照，不是完整事件流；`POST /send` 会绕过自动回复的 dryRun 和部分节流。因此新程序应直接接收逐条事件，并由一个出口统一管理预演、过滤、长度和发送频率。[插件主程序](https://github.com/newmegame/-dsh-bili-live/blob/0e7a393c10007d392ba733c902579876574e2e1b/index.js)

## 本机与旧原型的历史验证

旧实现已停止，采集钩子已移除，浏览器已交还。随后按用户要求删除旧代码、测试、依赖、协议资源、临时运行环境和调试数据；`.env` 与配置模板保留。以下是历史调研结论，新实现仍须重新验证。

此前原型在当前 Unity 4.0.51 页面实际完成过：指定友人房创建、三个电脑补位、开局、部分协议解码、LLM 选择合法弃牌、游戏接口执行并收到出牌事件、同步当前小局恢复。自动和牌按钮实测位于左侧工具栏。通过过 10 项针对牌型、协议、状态和候选的测试。

这些证据只证明部分链路曾经成立。完整连续对局、所有鸣牌与立直分支、直播联动、语音、OBS 和完整异常恢复尚未验收。旧实现及旧方案已清理，不再作为新工程的现成功能或测试资产。

本轮只读确认本机为 arm64，系统 `say` 可列出中文声音；尚未进行发声或 OBS 音轨实测。OBS 官方支持 macOS 浏览器源与较新系统上的音频采集，新方案可以采用独立语音音轨和字幕页面。[OBS 浏览器源](https://obsproject.com/kb/browser-source)、[macOS 音频采集](https://obsproject.com/kb/macos-desktop-audio-capture-guide)

## 实施前的验证顺序

1. 新实现阶段重新采集脱敏对局样本，验证 Akagi 引擎封装、事件重放和候选映射，特别是红五、立直＋弃牌和鸣牌组合。
2. 用模拟弹幕验证逐条接收、观众身份、去重、断线恢复以及聊天／解说的排队顺序。
3. 以本机语音和 OBS 本地预览验证字幕、音轨、排队合并；首版基本直播由独立程序完成。
4. 角色输出按 [Live2D 专题](./LIVE2D.md) 验证配套前端、模型映射、逐条播放回执和 OBS 透明视图；优先复用 Open-LLM-VTuber，AIRI 为组件备选。
5. 最后验证实际友人场、真实弹幕收发和连续运行；实测结论回填方案，不把 README 宣称当作验收结果。
