# Changelog

完整发布说明见 [GitHub Releases](https://github.com/lusipad/ado-ai-review-bot/releases)。

## v0.3.0（2026-07-11）

**Claude Code 双引擎**：`claude -p` 无头模式接入为第二种 agent 引擎——profile 支持 `engine:name` 格式（`claude`、`claude:opus`、`codex:deepseek`），可与 codex **交叉 review 同一个 PR**（不同 agent 架构的独立验证）；`REVIEW_ENGINE` 可整体切换默认引擎。安全映射：评审/问答限只读工具白名单，`/fix` 允许编辑但不放开任意 Bash；贴图提问自动转 Read 工具读取。

其他：README 重组（能力总览 / 新架构图 / 12 项验收清单 / 目录）；补 MIT LICENSE。

## v0.2.0（2026-07-11）

**更聪明的 review**：多模型交叉（codex profile，🤝 双命中标注）· 关联工作项对照 · 语言专项清单（C/C++、C#、TS/JS、Python、Java、Go）· git 历史考证 · 👀 人工审阅导读

**长期记忆**：仓库地图 + 项目术语表 · 累积记忆层（约定/坑/决策/术语，明文可编辑）· dream 每周日自动整理并推送团队规范建议 · 沟通风格卡（persona）

**交互与运营**：`@bot` 贴图提问（视觉模型）· RocketChat 群聊双向问答 + must-fix @ 责任人 · `/admin` 管理面板 · 优雅停机 + 启动恢复 · Service Hooks 一键接入脚本 · codex 瞬时失败重试 · 重复事件幂等

**安全基线**：allowFix 收权（不认 PR 分支配置）· `/fix` 规模护栏 + 受保护文件禁改 · 提示词防操纵条款 · 附件下载仅限 ADO 主机

**Server 2022 兼容**：评论事件 1.0 扁平 payload 自动补全 · connectionData 裸调 · HTTP 部署 header 鉴权

## v0.1.0（2026-07-10）

首个可用版本：深入 review（完整代码库 agent 探索）· 防抖增量 review + 自动关线程 · 质疑 pass 假阳性过滤 · 反馈学习（Won't Fix 记忆 + 采纳率自动降噪）· `@bot` 问答 · `/fix` 自动修复 · 仓库知识库 · `/stats` 度量 + 周报 · RocketChat / 企业微信通知 · 离线打包部署。已在 Windows 11 + Azure DevOps Server 2022 + codex 0.144 真实环境端到端验证。
