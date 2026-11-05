# 实际采用的上游与许可登记

[文档导航](../README.md) · [阶段 0 实测](../validation/technical-spikes.md)

登记日期：2026-11-05。范围是本机开发与评估；下列“声明”不等于已完成所有传递依赖、模型与素材的分发审查。当前没有发布安装包或模型包。

| 材料 | 固定来源／版本 | 核查与采用边界 |
| --- | --- | --- |
| Akagi `native_bot` | [源码 commit 63cea4b5](https://github.com/shinkuan/Akagi/tree/63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/native_bot) | 已读取根 Apache-2.0 LICENSE、NOTICE 与 crate 声明；作为 Rust Git 依赖构建，未启用上游自动操作／桌面程序 |
| Akagi 协议提取器／位置 XOR 算法 | 同一 commit 的 `scripts/extract_liqi.py`、`src/bridge/majsoul/parser.rs` | 本机运行提取器；游戏诊断函数中的 XOR 根据该实现适配。保留 [LICENSE](./licenses/akagi-LICENSE.txt) 与 [NOTICE](./licenses/akagi-NOTICE.txt) |
| Akagi 四麻权重 | 同一 commit 的 `native_bot/weights/akagi4p.safetensors` | SHA-256 `33c20aaba3f349ef689df73b726224804dc4aaff99922093d8f30cc38d709a1d`；随 native_bot 嵌入本机二进制。训练说明为天凤牌谱行为克隆；未找到独立模型许可／数据使用授权证据，保持分发待澄清，不把源码许可直接当成完整模型授权证明 |
| riichienv-core | Cargo.lock：0.4.11（上游依赖声明最低 0.4.8） | 实际锁定版本须以 Cargo.lock 为准；上游 NOTICE 登记 Apache-2.0。提供底层状态和合法动作，尚未验证本项目友人房规则兼容 |
| candle-core / candle-nn | Cargo.lock：0.9.2 | CPU 推理，传递依赖声明见下方 JSON；未接 Metal／CUDA |
| Node 与内置 SQLite | Node 24.22.1，SQLite 3.53.4 | 使用 vfox 分发的官方 arm64 运行时；保留其随附 LICENSE，SQLite 不额外引入驱动 |
| TypeScript | 5.9.3 | 实际 `node_modules/typescript/LICENSE.txt` 为 Apache-2.0，开发依赖 |
| @types/node | 24.10.1 | 实际 `node_modules/@types/node/LICENSE` 为 MIT，开发依赖 |
| protobufjs | 7.5.4 | 实际 `node_modules/protobufjs/LICENSE` 为 BSD-3-Clause，并明确排除另行标记／有独立 LICENSE 的目录；浏览器探测使用随包构建 |
| requests / UnityPy | 2.32.5 / 1.23.0 | 仅协议提取辅助环境；完整版本固定于 `scripts/protocol-requirements.lock`，未作为产品依赖分发；传递包的逐文件许可审查尚未完成 |
| 雀魂客户端资源 | 当前 Unity 4.0.51，bundle 与协议摘要见版本清单 | 原服务的公开下载资源，仅用于本机兼容性验证；没有声明其可再分发，未提交提取出的完整 proto／资源 |
| ego-browser / 系统中文声音 / OBS | 当前本机安装 | 调用本机工具；没有复制或分发浏览器、系统声音、OBS 程序 |
| Live2D / VRM / Cubism / 角色素材 | 本轮未引入 | 阶段 0 不提前搭建角色前端，无角色资产可用／授权的验收声明 |
| B站适配候选／DSH | 本轮未复制代码 | 不依赖 DSH 宿主，尚无已采用弹幕源码 |

[`rust-dependencies.json`](./rust-dependencies.json) 记录本次目标平台 Cargo metadata 中 112 项依赖的版本、来源及许可声明；它是元数据清单，不是逐文件许可审计。Rust 的完整解析与 checksum 在 [`Cargo.lock`](../../native/engine-runner/Cargo.lock)，npm 依赖在 [`package-lock.json`](../../package-lock.json)。分发二进制前需处理这些依赖的实际许可文件／声明，尤其是嵌入的权重；本轮不作“可任意分发”的结论。

Akagi 源码归档 SHA-256：`45786d0046ca8ab5b832c8ffdf0fbb7b470ed3d848730fbcb8123032f9f4cd43`。本机缓存与构建产物在 `.runtime`、`native/engine-runner/target`，均忽略提交。`LICENSE` 和 `NOTICE` 副本来源为上述固定 commit，保留原文，不代表本项目自身选择了相同许可证。
