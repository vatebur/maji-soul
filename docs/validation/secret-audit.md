# GitHub 首次上传前密钥检查

检查日期：2026-11-08（Asia/Shanghai）。

- 使用 Gitleaks 8.30.1 默认规则扫描首次上传前的全部 19 次历史提交，以及已跟踪和未忽略的待上传文件。
- 唯一告警是 `tests/fixtures/phase1-live-discard/events.jsonl` 的公开 `gameHandKey`，并非鉴权凭据。`.gitleaks.toml` 仅为该文件中的一个确切编号添加规则例外，保留其余默认检测；复扫无告警。
- 额外将本机 `.env` 与配置的 Cookie 文件中的敏感值与工作文件及全部 301 个历史 blob 对照，检查 6 个敏感值，无匹配。报告不记录其实际值。
- `.env`、本机配置、`data/`、`.runtime/` 和构建产物由 `.gitignore` 排除；另补充忽略 `.env.*`，保留 `.env.example`。
- 上传前再次扫描最终提交历史和索引内容。检测结果只覆盖本次工具规则和本机已知敏感值，不能保证发现所有形式的秘密。

复查命令（需本机安装 Gitleaks）：

```sh
gitleaks git . --config .gitleaks.toml --redact=100 --log-opts=--all
```
