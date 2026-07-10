# ADO AI Review Bot

Azure DevOps Server 2022 的 AI 代码评审机器人：

- **PR 创建 / 草稿转正式**自动触发**全量深入 review**（不占用 build agent）；
- **push 更新**防抖合并后只做**增量 review**，并自动把已修复的旧问题线程标记为已解决；
- 评论 `/review` 强制重审，任意线程 `@bot 提问` 得到**带代码依据的回答**；
- review 不是只看 diff：bot 在本地 checkout PR 的**完整代码**，用 Codex CLI（`codex exec`）驱动内网 OpenAI 兼容模型在真实代码库里 grep、读文件、追调用链；
- review 完成 / 发现必须修复问题 / 任务失败时推送 **RocketChat / 企业微信**群通知。

## 架构

```
Azure DevOps Server 2022
  │  Service Hooks Web Hooks（3 个订阅，带密钥）
  ▼
本服务 (Node.js)
  ├─ webhook 接收器        校验密钥、路由事件、过滤 bot 自身评论、立即 ACK
  ├─ 调度队列              每 PR 串行 + push 防抖 + 全局并发上限 + 问答优先通道
  ├─ 仓库工作区            git mirror 缓存 + 每任务独立 worktree（checkout 预合并结果）
  ├─ Codex 引擎            codex exec --sandbox read-only，输出结构化 JSON
  ├─ ADO 客户端            总评/行内评论线程、线程回复编辑、自动关线程、PR status
  ├─ IM 通知               RocketChat / 企业微信 incoming webhook（仅推送）
  └─ SQLite 状态库         iteration 追踪、finding 指纹去重、总评 threadId
        │
        ▼
内网 OpenAI 兼容 API（codex 的 model provider）
```

## 前置准备

### 1. ADO 服务账号与 PAT

1. 创建专用账号（如 `ai-review-bot`），bot 用它发评论；
2. 用该账号登录 ADO，创建 PAT：**Code → Read & Write**；
3. 把该账号加入需要接入的项目（Contributor 即可）。

### 2. 获取 bot 账号 GUID（`BOT_ACCOUNT_ID`）

用于过滤 bot 自身评论（防自触发循环）和匹配 `@bot` mention：

```bash
curl -u :$ADO_PAT "https://<ado>/<collection>/_apis/connectionData?api-version=7.0" \
  | jq '.authenticatedUser.id'
# 用 bot 账号的 PAT 调用，返回的 id 就是 GUID
```

### 3. 部署机

- 内网可达 ADO Server，且 ADO Server 可访问部署机的服务端口（防火墙放行）；
- Node.js 20+、git、[Codex CLI](https://github.com/openai/codex)；
- **推荐 Linux/Docker 部署**：codex 的 `--sandbox read-only` 在 Windows 原生支持较弱，如必须 Windows 请先手动验证 `codex exec --sandbox read-only` 可用，或通过 `CODEX_SANDBOX` 调整。

### 4. Codex 指向内网模型

部署机 `~/.codex/config.toml`（Docker 部署则挂载到容器 `/root/.codex/config.toml`）：

```toml
model = "<内网模型名>"
model_provider = "intranet"

[model_providers.intranet]
name = "Intranet OpenAI"
base_url = "http://<内网API地址>/v1"
env_key = "INTRANET_API_KEY"
wire_api = "chat"   # 兼容 chat completions 的内网服务用 chat
```

验证：`INTRANET_API_KEY=xxx codex exec "你好，报一下你的模型名"`。

## 部署

### Docker（推荐）

```bash
cp .env.example .env   # 填写 ADO_URL / ADO_PAT / WEBHOOK_SECRET / BOT_ACCOUNT_ID 等
docker build -t ai-review-bot .
docker run -d --name ai-review-bot \
  --env-file .env \
  -p 3000:3000 \
  -v ai-review-data:/app/data \
  -v ./codex-config.toml:/root/.codex/config.toml:ro \
  ai-review-bot
```

### 裸机 / Windows 服务

```bash
npm ci && npm run build
npm start                # 或用 systemd / nssm 托管 node dist/server.js
```

启动日志出现 `AI Review Bot 已启动` 后，`curl http://<bot>:3000/healthz` 应返回 `{"ok":true}`。

## 配置 Service Hooks（每个接入项目 3 个订阅）

ADO 项目 → **Project settings → Service hooks → Create subscription → Web Hooks**：

| # | 触发事件 | 筛选 | 说明 |
|---|---|---|---|
| 1 | Pull request created | 目标仓库/分支按需 | 触发全量 review |
| 2 | Pull request updated | **Change = Source branch updated** | 触发防抖增量 review |
| 3 | Pull request commented on | — | `/review` 命令与 `@bot` 问答 |

Action 页统一配置：

- **URL**：`http://<bot地址>:3000/webhook/ado`
- **Basic authentication password**：填 `WEBHOOK_SECRET` 的值（用户名任意）；
  或加 HTTP 头 `x-webhook-secret: <WEBHOOK_SECRET>`
- Resource details to send: All

每个订阅页面有 **Test** 按钮，点击后 bot 日志应出现 `事件已路由`。

> 订阅连续失败会被 ADO 自动禁用（Service Hooks 列表里显示红色 ⚠），排障后需手动 Enable。

## Review 行为定制

### 仓库内 `.ai-review.yml`（优先级最高，跟代码走）

```yaml
autoReview: true          # false = 该仓库只响应 /review 手动触发
maxInlineComments: 10     # 每轮行内评论上限，超出归并进总评
minSeverity: nit          # 最低上报级别：must-fix / suggestion / nit
ignorePaths:              # 忽略的路径（glob，支持 * 和 **）
  - vendor/**
  - "**/*.generated.cs"
focus: 重点关注线程安全和数据库事务边界。   # 追加进提示词
```

仓库根目录的 `AGENTS.md` 会被 codex 自动遵循，可写团队编码约定。

### bot 侧按仓库覆盖（`BOT_CONFIG_FILE` 指向的 JSON，适合不方便改仓库内容的项目）

```json
{
  "repoOverrides": {
    "MyProject/MyRepo": {
      "autoReview": false,
      "minSeverity": "suggestion",
      "notify": { "rocketchatWebhookUrl": "https://chat.corp.local/hooks/team-a" }
    }
  }
}
```

优先级：`.ai-review.yml` > bot 按仓库配置 > 全局默认（环境变量）。

### 提示词模板（`prompts/`，改动即生效无需重启）

- `review-full.md` — 全量 review
- `review-incremental.md` — 增量 review（含旧 finding 核对与自动关线程）
- `qa.md` — `@bot` 问答

## IM 通知

- **RocketChat**：管理 → Integrations → New Incoming Webhook，把生成的 URL 填入 `ROCKETCHAT_WEBHOOK_URL`；
- **企业微信**：群 → 添加群机器人，把 webhook key（或完整 URL）填入 `WECOM_WEBHOOK_KEY`；
- 事件过滤：`NOTIFY_EVENTS=review_completed,must_fix_found,job_failed`（按需删减）；
- 两者可同时启用；通知失败只记日志，不影响 review 本身。

## 使用方式（开发者视角）

| 动作 | 效果 |
|---|---|
| 建 PR（非草稿）/ 草稿转正式 | 自动全量 review：一条总评（摘要+变更导览+风险）+ 行内问题评论 + `ai-review` PR status |
| push 新提交 | 防抖 3 分钟后增量 review；已修复的旧问题线程被自动回复 ✅ 并置为 fixed |
| 评论 `/review` | 强制重新全量 review（可用于 autoReview 关闭的仓库） |
| 任意线程评论 `@ai-review-bot <问题>` | bot 先回「🔍 正在分析」，随后把该占位评论编辑为带代码依据的回答 |

行内评论标签：🔴 必须修复 / 🟡 建议 / 🔵 细节。bot 不投票，不阻塞审批（如需卡口，可在分支策略里把 `ai-review` status 设为必需）。

## 上线验收清单

1. 建一个含**跨文件缺陷**的测试 PR（如改了函数签名但没改某个调用方）→ 自动出现总评 + 行内评论，且能指出跨文件问题（验证「深入」而非只看 diff）；
2. 草稿 PR 不触发；转正式后触发；
3. 连续 push 两次 → 防抖窗口后只出**一次**增量 review，且不重复旧意见；按意见修复后再 push → 旧 finding 线程被自动回复并标记已解决；
4. 在行内评论线程 `@ai-review-bot 这里为什么有风险？` → 同线程收到有代码依据的中文回复；
5. `/review` → 强制全量重审；
6. bot 自己的评论不引发新触发（无死循环）；
7. 同时开 2~3 个不同分支的 PR + 在其中一个 review 进行中发 `@bot` 提问 → 各 PR 互不串扰、问答不被长任务阻塞、同一 PR 连续触发只跑一次；
8. review 完成后 RocketChat / 企业微信群收到摘要消息；故意配错 webhook URL → review 正常完成，日志有通知失败告警。

## 开发

```bash
npm ci
npm test          # vitest：事件路由 / 调度防抖 / codex 输出解析 / git 工作区 / 端到端（mock ADO + 假 codex）
npm run build
```

## 一键打包（离线部署包）

打包机需要能访问 npm registry；产出的部署包**自包含**（已编译 + 生产依赖），部署机无需联网装依赖：

```bash
npm run package          # Linux/macOS/WSL → release/ai-review-bot-<版本>-linux-x64.tar.gz
npm run package:win      # 在 Windows 上运行 → release/ai-review-bot-<版本>-win32-x64.zip
npm run package:docker   # 额外产出离线 Docker 镜像 release/ai-review-bot-<版本>-docker.tar
```

- 打包流程 = `npm ci` → 编译 → 跑全部测试 → 组装（dist + 生产 node_modules + prompts + 启动脚本 + 部署说明）→ 归档；测试不过不出包（可加 `--skip-tests` 跳过，不推荐）。
- ⚠️ tar.gz / zip 含原生模块（better-sqlite3），**只能部署到与打包机相同的 OS/架构**——Windows 部署包必须在 Windows 上打；跨平台用 Docker 镜像包。
- 部署机上解压后：`cp .env.example .env` 填配置 → `./start.sh`（Windows 用 `start.ps1`），注册系统服务的方法见包内 `DEPLOY.md`。
- Docker 镜像包在内网机 `docker load -i ai-review-bot-<版本>-docker.tar` 即可用。

## 故障排查

| 现象 | 排查 |
|---|---|
| 收不到事件 | ADO Service Hooks 订阅历史（每条通知有请求/响应详情）；防火墙；订阅是否被自动禁用 |
| 401 | 订阅里的密钥与 `WEBHOOK_SECRET` 不一致 |
| review 一直 pending | bot 日志看 codex 是否超时（`CODEX_TIMEOUT_MS`）；`codex exec` 手动验证内网模型连通性 |
| 行内评论位置不对 | 确认模型输出的行号基于 worktree 实际文件；提示词已要求核对，必要时在 `.ai-review.yml` 降低 `maxInlineComments` 观察 |
| PR 有冲突 | 无预合并 commit，bot 回退到源分支 review 并在总评顶部注明 |
