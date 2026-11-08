# VTuber 中文语音方案调查

调查日期：2026-11-07（Asia/Shanghai）。以下调查正文保留切换前的代码快照与候选建议；当时未安装候选引擎、未进行音质试听或本机性能测试。上游链接是调查时的默认分支快照，尚未固定为采用版本。以下推荐是工程判断，不是音质实测排名。

后续采用：用户试听 Fish 后指定音色 `c5c17c9709384ba9a4b294662a2af0b1`，并要求替换系统 TTS、不加入开心情绪。控制台现已接入 Fish，默认模型 `s2.1-pro-free`，不添加情绪提示；旧 `macos` 配置自动迁移。当前用法见 [USAGE](../USAGE.md#阶段-345-直播演练)，验证见[直播输出记录](../validation/live-output.md)。正文中的“当前项目”和“待实现”描述均为采用前的调查结论。

## 1. 结论

当前的生硬感需要同时处理声音、口播文本和播放节奏。建议先用同一组麻将短句，对 **Fish Audio API、MiniMax API、当前 macOS 声音**做盲听比较；希望本地运行和固定角色声线时，优先验证 **GPT-SoVITS**。需要中文情绪指令和双向流式时再验证 **CosyVoice**。Edge TTS 可做低接入成本的对照，但其表达控制有限。

无需搬入整套 VTuber 框架。保留本项目的对局、弹幕和播报调度，借鉴其 TTS 适配、分句与表达控制即可。

## 2. 当前项目为什么容易有播报感

已核对的实现：

- [`macos-speech.ts`](../../src/adapters/live/macos-speech.ts)：调用 `/usr/bin/say` 生成完整 AIFF，再交给 `afplay` 播放；当前只设置音色，没有情绪或语速参数。
- [`speech.ts`](../../src/application/live/speech.ts)：`SpeechPort.synthesize` 接收文本、音色和取消信号，返回完整音频文件路径；最多四条普通解说通过 `join('')` 拼接后一次合成，没有专门的段间停顿策略。原文本的标点仍然保留。
- [`config.ts`](../../src/application/live/config.ts)：provider 和校验均只接受 `macos`，不是只改配置就能换引擎。
- [`commentary.ts`](../../src/adapters/llm/commentary.ts)：弃牌解说按证据模板选择，观众回复默认最多 20 字并共用于口播、弹幕。其可追溯性应保留，但口语节奏需要单独设计。

这些是代码事实；它们对听感的影响仍需对照试听确认。仅换声线不能保证整套解说自然。

## 3. 值得参考的 VTuber 项目

| 项目 | 核对到的方案 | 本项目可以借用什么 |
| --- | --- | --- |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 多种可替换 TTS；默认配置有分句、首句提前触发；支持 GPT-SoVITS、CosyVoice、Fish、MiniMax、Edge 等 | 统一适配层、分句、把展示内容与可朗读内容分开；不必接入其整套 Agent |
| [ikaros-521/AI-Vtuber（Luna AI）](https://github.com/ikaros-521/AI-Vtuber) | 面向直播互动，列出 Edge、GPT-SoVITS、Fish Speech、CosyVoice、ChatTTS 等，并结合数字人输出 | 直播场景下的语音后端选择与播放链路参考；README 列出的支持不等于各后端都已通过稳定性实测 |
| [N.E.K.O.](https://github.com/Project-N-E-K-O/N.E.K.O) | Realtime 对话和 ChatCompletion 文本模式；云端语音与本地 CosyVoice／GPT-SoVITS，并提供依赖供应商的声音克隆 | 角色声线与语音会话设计；当前雀魂逐手解说已有事实约束，没必要为了语音改成完整端到端实时对话 |

Open-LLM-VTuber [默认配置](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/config_templates/conf.default.yaml)中的 `faster_first_response` 会尝试提前触发首句合成。该项目 README 同时说明 v2 正在讨论／规划，v1 继续修复问题；如复用代码，应先固定具体版本。

## 4. 引擎选择

| 候选 | 上游证据 | 对当前 Mac 雀魂直播的判断 |
| --- | --- | --- |
| **Fish Audio API** | [S2 情绪文档](https://github.com/fishaudio/docs/blob/main/developer-guide/core-features/emotions.mdx)支持方括号形式的情绪、语气提示，包括中文 | 优先试听对象，适合验证开心、紧张、吐槽等表达；先用 API 避免本地模型资源争用。实际延迟、费用和声线效果待测 |
| **MiniMax API** | Open-LLM-VTuber 有[独立适配器](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/tts/minimax_tts.py)，包含 voice、speed、pitch、读音词典和流式请求 | 与 Fish 同组试听；不直接照抄上游默认模型及域名，正式接入时核对供应商当前接口。此处未独立验证其情绪参数 |
| **GPT-SoVITS** | [官方 README](https://github.com/RVC-Boss/GPT-SoVITS)提供短参考音频克隆、少量数据微调、中文及 Apple Silicon 环境说明 | 本地固定角色声线的首选验证对象。音色相似与情绪自然是两个指标，参考音频需要覆盖目标表达。官方 macOS 章节提示 GPU 训练质量问题；不能把它扩大解释为所有推理均不可用 |
| **CosyVoice 3** | [官方 README](https://github.com/QwenAudio/CosyVoice)列出中文、零样本克隆、情绪／语速等指令、文本输入和音频输出双流式 | 适合进一步做中文表达和低延迟服务。当前官方示例主要围绕 CUDA 等部署路径，本轮没有验证 Apple Silicon 的安装和实时性能；可先独立服务部署 |
| **Edge TTS** | [官方仓库](https://github.com/rany2/edge-tts)支持在线音色及语速、音高、音量；明确移除了自定义 SSML | 接入轻、无需本地模型，可作基线；不能把调整音高当成情绪控制，也不能照搬 Azure 的 SSML 表达能力 |

补充版本区别：当前 [Fish Speech 仓库](https://github.com/fishaudio/fish-speech)已同时介绍 Drama 3 和 S2-Pro，自托管仓库与云 API 的模型、许可并不相同。不能沿用旧教程笼统称为一个开源模型。仓库当前标注 Community License，而 S2-Pro 权重仍标注 Research License；正式选型时需按实际版本、权重和服务条款分别核对。

## 5. 不能直接照搬的流式实现

核对 Open-LLM-VTuber 两个适配器发现：

- [MiniMax 适配器](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/tts/minimax_tts.py)设置 `stream: True`，但把音频块累积到 `audio` 后才写文件返回。
- [GPT-SoVITS 适配器](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/tts/gpt_sovits_tts.py)也在获得响应后将 `response.content` 写成文件。

所以“供应商流式响应”“按句开始合成”“收到第一块即可播放”是三个不同能力。当前 `SpeechPort` 返回文件路径，可以先做按句合成；若要边收边播，需要扩展音频交付／播放器接口，继续保证清空、静音、过期和取消能阻止迟到音频播放。上游宣称的毫秒延迟不能当作本机端到端延迟。

## 6. 建议接入顺序（待实现）

1. **先试听选声音**：保持相同文本，对照当前 macOS、Fish 和 MiniMax。需要离线时增加 GPT-SoVITS，确定声线后再做微调。
2. **先接完整短句音频**：新增 provider 适配与配置校验，用现有播放器验证音质、错误和取消，不把流式播放器作为第一步前置条件。
3. **单独设计口播表达**：增加受约束的 `emotion`、`intensity`、`rate` 元数据，供应商适配器负责映射。字幕和弹幕保留干净文本；不能把 Fish 标签直接交给其他引擎朗读。牌理事实与证据引用保持原约束。
4. **调整队列节奏**：待播旧解说压缩为一句回顾或丢弃，避免直接堆成长段；按语义完整短句合成，避免每逢逗号切割导致韵律破碎。
5. **再做真正边收边播**：独立测量首个声音时间、句间空白、取消到静音时间及过期音频残留，同时检查 OBS 实际录制音轨。

本轮只新增调查记录，未修改运行中的 TTS、安装模型或调用付费语音服务。

## 7. 同文试听与验收建议

以下仅为测试台词，不代表真实对局事实。每个候选用相同声线定位、相同文本连续生成三次，分别听平静版本和轻度情绪版本：

| 场景 | 台词 |
| --- | --- |
| 普通弃牌 | 这张九万先打掉，留住中间的搭子。 |
| 思考停顿 | 嗯……这手先别急，再看一巡。 |
| 立直反应 | 哎，对面立直了，这下要小心一点。 |
| 和牌兴奋 | 摸到了！这张来得正是时候。 |
| 吐槽 | 这张牌，你是不是故意最后才来的呀？ |
| 弹幕互动 | 哈哈，看见你的弹幕啦。 |
| 术语与数字 | 两面听，三番三十符，一千点。 |
| 回顾与过期 | 上一局回顾，我们最后选择了防守。 |

人工评分：自然度、角色一致性、情绪是否过度、麻将术语发音、短句尾音。记录网络条件、引擎／模型版本、参考音频、首个声音时间和总时长；本地模型另测与浏览器、麻将引擎、OBS 并行运行时的资源占用。

建议将“静音／清空无残留播放、过期内容不播、对局不等待语音”作为接入门槛。未完成同文试听前，不宣称任何候选已经解决生硬问题。
