# 一键打包（Windows 原生部署用，在 Windows 上运行）
#
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1 -SkipTests
#
# 产出 release\ai-review-bot-<版本>-win32-x64.zip
# 注意：zip 里的 node_modules 含原生模块（better-sqlite3），必须在 Windows 上打包才能在 Windows 上运行。
param(
  [switch]$SkipTests
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$version = node -p "require('./package.json').version"
$platform = node -p "process.platform + '-' + process.arch"
$name = "ai-review-bot-$version-$platform"
$releaseDir = Join-Path (Get-Location) "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

Write-Host "==> [1/5] 安装依赖"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci 失败" }

Write-Host "==> [2/5] 编译"
npm run build
if ($LASTEXITCODE -ne 0) { throw "编译失败" }

if (-not $SkipTests) {
  Write-Host "==> [3/5] 运行测试"
  npm test
  if ($LASTEXITCODE -ne 0) { throw "测试失败" }
} else {
  Write-Host "==> [3/5] 跳过测试"
}

Write-Host "==> [4/5] 组装部署目录"
$stageRoot = Join-Path $env:TEMP ("ai-review-pkg-" + [System.Guid]::NewGuid().ToString("N"))
$stage = Join-Path $stageRoot "ai-review-bot"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -Recurse dist, prompts $stage
Copy-Item package.json, package-lock.json, .env.example $stage
Copy-Item scripts\start.sh, scripts\start.ps1, scripts\DEPLOY.md $stage

Push-Location $stage
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "生产依赖安装失败" }
Pop-Location

Write-Host "==> [5/5] 归档"
$zipPath = Join-Path $releaseDir "$name.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path $stage -DestinationPath $zipPath
Remove-Item -Recurse -Force $stageRoot

Write-Host ""
Write-Host "✅ 打包完成: release\$name.zip"
Write-Host "   拷到部署机解压后，按包内 DEPLOY.md 操作。"
