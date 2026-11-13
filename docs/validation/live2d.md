# Live2D 口播输出验证

日期：2026-11-13（Asia/Shanghai）。当前采用 Soullink Emotion SDK 的 npm `0.1.0-beta.1`，具体依赖和许可见[上游登记](../research/UPSTREAM.md)，操作见[使用说明](../USAGE.md#live2d-口播与-obs-角色源)。

## 已验证的代码与接口

在 Mac、Node 24.22.1 环境运行：

```sh
node --test tests/avatar-output.test.ts tests/avatar-playback.test.ts tests/avatar-http.test.ts tests/avatar-profile.test.ts
```

新增 27 项测试，在允许 loopback 的执行环境全部通过、无跳过；`npm run check` 和 `npm run build:avatar` 通过。测试使用合成音频字节和 AudioContext 替身，不把它们计为真实人物、真实声卡或 OBS 验收。

| 范围 | 已验证行为 |
| --- | --- |
| 队列与回执 | 浏览器 prepare 不算已经开播；clear 取消准备、保留 started；mute 等待停止回执再释放 MP3 |
| 取消与过期 | 取消规划后迟到结果不派发；已发 play 需等待 stop 回执或租约到期；旧 ended 不能把取消改为成功 |
| 单一播放端 | 第二个 renderer 不能抢占；旧租约回执不能完成新实例；完成后的轮询没有历史重播指令 |
| 音频与动作时钟 | 解码时长用于动作规划；AudioContext 时钟前进才报告 started；同音源 RMS 口型，停止后归零 |
| 本机 HTTP | Origin 必须匹配；未知请求字段拒绝；音频 URL 绑定租约与当前语音；OBS 字幕快照不泄露租约 |
| 控制台试听 | 固定台词经过原队列完成；拒绝自定义台词、无播放端、忙与静音状态；完成后 30 秒冷却不重复合成 |
| 模型资源 | 只开放清单显式引用；目录中其他文件不可读取；拒绝越界路径与符号链接；不向页面暴露原始文件路径 |
| 租约时钟 | 本地单调时钟扣除完整往返耗时；将截止点安排到 WebAudio 线程，JS 冻结仍停止；延迟处理的 ended 不把提前停止改为成功 |
| Profile 边界 | 动作参数只使用已校准的表情／头身／手臂通道，范围取模型实际值与 Profile 的交集；剔除嘴部和 renderer 分组元数据 |

角色链路集成代码的 `npm run verify` 已在允许 loopback 的环境运行：**784 项通过、0 失败、0 跳过**。远端部署前另跑 TypeScript 检查及 16 项接口／适配器测试，全部通过。新增角色接口覆盖服务端无角色页面时不调用合成，以及 prepare／play／stop 转换。随后修复脸部遮罩兼容问题，另跑 `tests/avatar-renderer-compat.test.ts` 的 **4 项定向回归测试**以及 TypeScript 检查、前端构建，全部通过；未将这 4 项写成已完成新一轮全量验证。

OpenAPI 静态检查覆盖 36 个路径、37 个唯一 operationId、689 处有效本地引用和路径参数一致性；12 份相关 Markdown 的本地文件链接与代码围栏检查通过。这不是完整 OpenAPI 元 schema 或真实视觉运行验证。

## 角色资源与实际运行证据

用户提供的源目录为 `DeepSeek-chan`，运行时清单为 `DeepSeek/大肥鱼.model3.json`。清单明确引用 moc3、5 张纹理、physics3 和 cdi3；DisplayInfo 登记 509 个参数。原清单的 LipSync 参数组为空，需要在适配 Profile 中显式设置口型参数。源目录另有 Animation／Exp3 文件，但不在原清单引用范围内，当前资源服务不会自动开放这些目录。

| 源文件 | SHA-256 |
| --- | --- |
| `DeepSeek/大肥鱼.model3.json` | `ab4fc69a4f7c96a6b245d016061c4edb12cb1f23c442fa28e6f6d118e3c4e2b1` |
| `DeepSeek/大肥鱼.moc3`（16,498,560 字节） | `b708e7953db9deeb5bf783643255dee1f3bf20d24786bc287e72d07e1b1052e6` |

已读取随用户资源附带的英文使用条款：允许个人直播、视频与通常的平台内容收益，公开作品需标注模型作者和来源，不允许重新分发完整模型。作者为 Illustration／PSD：**Kamiya Ryoko**，Live2D Rigging：**霓虹猫_NeonNeko**。本次未修改用户下载目录，角色文件留在忽略提交的本机／部署数据目录；参数 Profile、Core 来源与最终部署路径另记实际结果。

本机 Core 通过[Live2D 官方下载入口](https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js)取得，公开版本 API 返回 **5.1.0**（83951616），SHA-256 为 `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f`。实际 moc3 已由 Core 加载并测得 509 个参数；`scripts/profile-deepseek-avatar.mjs` 据此生成 `data/avatar/deepseek/soullink.profile.json`，校准 24 个表情／头身／手臂目标，排除服装、体型与可见性开关。口型目标 `ParamMouthOpenY` 单独留给实际音频分析，默认闭嘴。

本机 `127.0.0.1:17861` 浏览器初次烟测已加载并显示真实模型，截图保存在运行临时目录。真实 Fish 音频完成 started → completed，采样 RMS 为 0–0.169、嘴部输出为 0–0.052；该轮动作 provider 为 `vad-facs`，因云规划在 4 秒配置下超时降级，**不计为云生成动作通过**。

后续校准将嘴部映射 scale 设为 8、输出限制在 0–1；真实音频再次采样峰值 RMS 0.1414，对应 mouthOpen 0.4317，停止后归零。当前 Profile SHA-256 为 `92cbed4479eb9c8423c48202648d223560fdae4f6d4725e296a02d2c3e743b2b`。浏览器 WebGL 上下文 alpha 实测为 true，body／html 为 rgba(0,0,0,0)。

同一兼容服务的 `gpt-6.1-sol` 独立参数规划探测使用 `reasoning_effort=low`，5,871 毫秒返回 2 个动作片段；completion tokens 为 139、reasoning tokens 为 0。随后完整远端验证使用了同一配置，结果如下；单次成功不代表每次实时请求都能在超时前返回。

远端 OBS 已新增 `DeepSeek-chan Live2D` 浏览器源，截图 `maji-obs-live2d-deployed.png` 显示角色透明叠加在原游戏画面上，角色服务 connected=true。源音频已路由到轨道 1，未静音、监听关闭；未开启推流或录制。随后使用控制台同一固定试听接口完成真实远端 Fish → 云动作 → 角色播放，结果为 completed，动作 provider 为 openai-compatible；关联 contentId 为 `fea3115d-0451-4081-8563-20041ead099e`。

用户观察到脸部出现鼻部白块、嘴部阴影和异常泛红。实际模型有 715 个 drawable、49 组独立遮罩，超过当前 PIXI／Cubism 渲染器默认单张遮罩图集的 36 组容量；溢出后遮罩重叠导致上述显示错误。`src/app/console/avatar-renderer-compat.ts` 检查独立遮罩数量，只对超过图集容量的模型启用 512 像素高精度遮罩，其余模型保留原有路径。此修复不改动角色参数或 Profile。本机修复后截图 `maji-avatar-face-fixed.png` 已确认鼻部白块、嘴部异常阴影消失；4 项定向测试覆盖超容量、重复遮罩去重、已有多图集和不兼容 renderer 的显式失败。

最终远端 OBS 截图 `maji-obs-halfbody-fixed-hires.png` 已确认遮罩修复生效，并按用户要求放大到画面右下方的腰部以上构图。源原生尺寸调整为 1200×1800，裁剪左／上／右／下为 380／200／380／1060，缩放 1.15，位置 (1400,459)，最终可见尺寸为 506×621。相较原先对较小源直接放大 2.3 倍，此设置以两倍原生采样提高脸部清晰度。该次短时观察 OBS 为 30 FPS、CPU 约 2.9%；该读数不代表长期性能验收。

遮罩修复与构图调整后再次完成远端真实试听：contentId 为 `d79d800c-f273-4457-8458-047f664e3629`，speechId 为 `88b8eac9-ecc6-4569-856d-c50a54bffed1`，结果 completed，provider 为 openai-compatible，完成时间为 `2026-11-13T11:31:08.635Z`。随后角色保持 connected=true、播放空闲。

部署前读取远端控制台，自动对局处于停止状态、`enabled=false`，最近错误为已有的 `ENDED_NOTICE_SCOPE_CHANGED`。此次角色接入不恢复或修复牌局；更新服务应保持原先停止状态，避免 systemd 原有 `--auto-start` 在重启时意外开启新场。

自动化结果证明调度、协议与资源边界；本机烟测证明上述模型显示、真实音频播放、透明画面和口型链路，远端 OBS 已确认透明叠加、脸部遮罩修复及腰部以上构图。真实远端云动作＋语音试听已完成；场景隐藏／重载及长期资源使用未据此验收，不据单次试听声称动作自然度或长期稳定性通过。

## 动作变化优化（2026-11-13）

发现每句 `runtime.reset()` 会重置随机序列和待机排重历史；云动作最多 3 帧，且其绝对参数覆盖了眨眼／呼吸。此次将自然结束改为保留运行时历史、平滑回中，取消／失败仍完整清理；每句使用不同反应 seed。待机与语音使用连续的同一虚拟时间轴，待机由单调时钟推进，讲话由实际 AudioContext 推进。采用 SDK lively 待机样式，校准头身待机范围，增加有界的讲话细节，并把口型／眼睛开闭／呼吸留给本地控制器。

云规划改为按约 2.5 秒分配目标（普通短句至少 2 个，最多 8 个），姿态过渡最多 0.9 秒；请求提示覆盖完整心情顺序及头、身、视线、手臂组合。每句最多 1 次实际网络请求，保留超时、取消、参数校验和降级行为。

`npm run verify`：**817 项通过、0 失败、0 跳过**，TypeScript 检查通过；`npm run build:avatar` 通过。新增实际 SDK 测试验证双时钟切换、重复反应不重用 seed、云计划不能锁住眨眼／呼吸、保持姿态时仍有细节变化，以及所有停止结果立即闭嘴。

本机 ego-browser 加载实际 DeepSeek-chan 模型。音频未启用时连续采样 8 秒，headX 为 −1.6325–0.8851、bodyZ 为 −0.8792–0.8020，口型始终为 0。使用 **12 秒合成波形与固定动作夹具** 完成 speaking → ready，headX 为 −6.5230–8.7067、bodyZ 为 −2.1444–3.0883、口型为 0–0.3121，结束后 RMS／口型均为 0、状态 IDLE。已查看不同姿态截图，模型脸部遮罩正常；本轮不是新一次 Fish／云动作服务验收，也未更新远端 OBS。

本机 Profile 已由更新后的脚本重新生成，SHA-256 为 `938cbffbe560795e49ddfa8e86c0c013f79a593e9bfb9677e24e734fa4bb5057`。采样记录和测试日志位于忽略提交的 `.runtime/avatar-motion-samples.json`、`.runtime/avatar-motion-verify.log`；姿态截图在临时目录 `maji-avatar-motion-pose-{3,8,13}.png`。远端需部署新代码、重新生成 Profile、构建并刷新角色源后才能使用此轮优化。
