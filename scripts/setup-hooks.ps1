<#
.SYNOPSIS
  为 ADO 项目一键创建/更新 AI Review Bot 所需的 3 个 Service Hooks 订阅（幂等，可重跑）。

.DESCRIPTION
  参数全部按 ADO Server 2022 实测的正确姿势：
  - 鉴权用 x-webhook-secret HTTP header（HTTP URL 不允许 basic auth 密码）；
  - 评论事件 Resource version 必须 1.0（2.0 显示支持但从不投递）；
  - resourceDetailsToSend = all。

.EXAMPLE
  .\setup-hooks.ps1 -Project MyProject -BotUrl http://bot-host:3000
  .\setup-hooks.ps1 -AllProjects -BotUrl http://bot-host:3000
  # ADO_URL / ADO_PAT / WEBHOOK_SECRET 默认从同目录或上级目录的 .env 读取，也可用参数覆盖
#>
param(
  [string[]]$Project,
  [switch]$AllProjects,
  [Parameter(Mandatory = $true)][string]$BotUrl,
  [string]$AdoUrl,
  [string]$AdoPat,
  [string]$WebhookSecret
)

$ErrorActionPreference = 'Stop'

# ---- 从 .env 补齐缺省参数 ----
$envFile = @("$PSScriptRoot\..\.env", "$PSScriptRoot\.env", ".\.env") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($envFile) {
  $envMap = @{}
  Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2; $envMap[$k.Trim()] = $v.Trim()
  }
  if (-not $AdoUrl) { $AdoUrl = $envMap['ADO_URL'] }
  if (-not $AdoPat) { $AdoPat = $envMap['ADO_PAT'] }
  if (-not $WebhookSecret) { $WebhookSecret = $envMap['WEBHOOK_SECRET'] }
}
foreach ($p in @(@('AdoUrl', $AdoUrl), @('AdoPat', $AdoPat), @('WebhookSecret', $WebhookSecret))) {
  if (-not $p[1]) { throw "缺少 $($p[0])：请传参数或在 .env 中配置" }
}
if (-not $Project -and -not $AllProjects) { throw '请指定 -Project <名称>（可多个）或 -AllProjects' }

$AdoUrl = $AdoUrl.TrimEnd('/')
$webhookUrl = "$($BotUrl.TrimEnd('/'))/webhook/ado"
$auth = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(":$AdoPat")) }

# ---- 目标项目列表 ----
if ($AllProjects) {
  $Project = (Invoke-RestMethod -Uri "$AdoUrl/_apis/projects?`$top=500&api-version=7.0" -Headers $auth).value.name
  Write-Host "共 $($Project.Count) 个项目" -ForegroundColor Cyan
}

# 事件类型 → resourceVersion（评论事件必须 1.0，见 README）
$events = [ordered]@{
  'git.pullrequest.created'                   = '1.0'
  'git.pullrequest.updated'                   = '1.0'
  'ms.vss-code.git-pullrequest-comment-event' = '1.0'
}

$existing = (Invoke-RestMethod -Uri "$AdoUrl/_apis/hooks/subscriptions?api-version=7.0" -Headers $auth).value

foreach ($proj in $Project) {
  $projectId = (Invoke-RestMethod -Uri "$AdoUrl/_apis/projects/$([uri]::EscapeDataString($proj))?api-version=7.0" -Headers $auth).id
  foreach ($evt in $events.Keys) {
    $dup = $existing | Where-Object {
      $_.eventType -eq $evt -and
      $_.publisherInputs.projectId -eq $projectId -and
      $_.consumerInputs.url -eq $webhookUrl
    }
    $body = @{
      publisherId      = 'tfs'
      eventType        = $evt
      resourceVersion  = $events[$evt]
      consumerId       = 'webHooks'
      consumerActionId = 'httpRequest'
      publisherInputs  = @{ projectId = $projectId }
      consumerInputs   = @{
        url                   = $webhookUrl
        httpHeaders           = "x-webhook-secret: $WebhookSecret"
        resourceDetailsToSend = 'all'
      }
    } | ConvertTo-Json -Depth 5

    if ($dup) {
      # 已存在 → 覆盖更新（密钥轮换/参数修正场景）
      Invoke-RestMethod -Method Put -Uri "$AdoUrl/_apis/hooks/subscriptions/$($dup[0].id)?api-version=7.0" `
        -Headers $auth -ContentType 'application/json' -Body $body | Out-Null
      Write-Host "[$proj] 更新 $evt" -ForegroundColor Yellow
    }
    else {
      Invoke-RestMethod -Method Post -Uri "$AdoUrl/_apis/hooks/subscriptions?api-version=7.0" `
        -Headers $auth -ContentType 'application/json' -Body $body | Out-Null
      Write-Host "[$proj] 创建 $evt" -ForegroundColor Green
    }
  }
}
Write-Host "完成。验证：在任一项目建一个测试 PR，bot 日志应出现「事件已路由」。" -ForegroundColor Cyan
