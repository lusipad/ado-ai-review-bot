# 部署包内的启动脚本（Windows）：读取同目录 .env 并启动服务
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Write-Error "缺少 .env：请复制 .env.example 为 .env 并填写必填项（见 DEPLOY.md）"
  exit 1
}

node --env-file=.env dist/server.js
