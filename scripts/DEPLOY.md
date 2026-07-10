# 部署包使用说明

这个目录是 `package.sh` / `package.ps1` 产出的**自包含部署包**：已编译（`dist/`）、已带生产依赖（`node_modules/`），部署机**不需要访问 npm registry**。

## 部署机要求

- Node.js 20.6+（启动脚本用了 `node --env-file`）
- git（bot 需要 clone/fetch 仓库）
- Codex CLI，且 `~/.codex/config.toml` 已指向内网模型（模板见主 README）
- 网络：能访问 ADO Server；ADO Server 能访问本机服务端口（默认 3000，防火墙放行）

> ⚠️ 包内 node_modules 含原生模块（better-sqlite3），只能在与打包机相同的 OS/架构上运行
> （文件名里的 `win32-x64` / `linux-x64` 就是目标平台）。跨平台请用 Docker 镜像包或重新打包。

## 启动

```bash
cp .env.example .env      # 4 个必填：ADO_URL / ADO_PAT / WEBHOOK_SECRET / INTRANET_API_KEY
./start.sh                # Windows: powershell -ExecutionPolicy Bypass -File start.ps1
curl http://localhost:3000/healthz   # {"ok":true} 即成功
```

## 注册为系统服务

**Linux (systemd)** — `/etc/systemd/system/ai-review-bot.service`：

```ini
[Unit]
Description=AI Review Bot
After=network.target

[Service]
WorkingDirectory=/opt/ai-review-bot
ExecStart=/usr/bin/node --env-file=.env dist/server.js
Restart=always
User=aireview

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now ai-review-bot
```

**Windows (nssm)**：

```powershell
nssm install AiReviewBot "C:\Program Files\nodejs\node.exe" "--env-file=.env dist\server.js"
nssm set AiReviewBot AppDirectory "C:\opt\ai-review-bot"
nssm set AiReviewBot AppStdout "C:\opt\ai-review-bot\logs\out.log"
nssm set AiReviewBot AppStderr "C:\opt\ai-review-bot\logs\err.log"
nssm start AiReviewBot
```

> Windows 原生部署前，先验证 codex 沙箱可用：
> `codex exec --sandbox read-only "你好"`。不可用时见主 README「Windows 部署」一节的取舍说明。

## 离线 Docker 镜像包（ai-review-bot-*-docker.tar）

```bash
docker load -i ai-review-bot-<版本>-docker.tar
docker run -d --name ai-review-bot --env-file .env -p 3000:3000 \
  -v ai-review-data:/app/data \
  -v ./codex-config.toml:/root/.codex/config.toml:ro \
  ai-review-bot:<版本>
```

## 后续步骤

服务起来之后：去 ADO 项目配置 3 个 Service Hooks 订阅（步骤见主 README「配置 Service Hooks」），然后按验收清单跑一遍测试 PR。

升级：解压新包覆盖 `dist/`、`node_modules/`、`prompts/`，保留 `.env` 和 `data/`（SQLite 状态与 mirror 缓存），重启服务即可。
