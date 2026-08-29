$ErrorActionPreference = "Stop"
$Backup = Join-Path $env:LOCALAPPDATA "AgentPocket\power-backup.json"
if (-not (Test-Path -LiteralPath $Backup)) { throw "未找到休眠设置备份：$Backup" }
$State = Get-Content -Raw -LiteralPath $Backup | ConvertFrom-Json
& powercfg /setacvalueindex ([string]$State.scheme) SUB_SLEEP STANDBYIDLE ([int]$State.acStandbySeconds)
if ($LASTEXITCODE -ne 0) { throw "恢复交流电休眠失败。" }
& powercfg /setactive ([string]$State.scheme)
Remove-Item -LiteralPath $Backup -Force
Write-Host "交流电休眠设置已恢复。"
