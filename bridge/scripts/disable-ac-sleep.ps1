$ErrorActionPreference = "Stop"
$StateRoot = Join-Path $env:LOCALAPPDATA "AgentPocket"
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
$Backup = Join-Path $StateRoot "power-backup.json"
if (Test-Path -LiteralPath $Backup) { throw "休眠设置已有备份：$Backup。请先恢复或手动移走备份。" }

$SchemeLine = & powercfg /getactivescheme
$Scheme = [regex]::Match(($SchemeLine -join " "), "[0-9a-fA-F-]{36}").Value
if (-not $Scheme) { throw "无法读取当前电源方案。" }
$Values = (& powercfg /query $Scheme SUB_SLEEP STANDBYIDLE) | Select-String -AllMatches "0x[0-9a-fA-F]{8}" | ForEach-Object { $_.Matches.Value }
if ($Values.Count -lt 2) { throw "无法读取交流电休眠时间。" }
$AcSeconds = [Convert]::ToInt32($Values[-1].Substring(2), 16)
@{ scheme = $Scheme; acStandbySeconds = $AcSeconds } | ConvertTo-Json | Set-Content -LiteralPath $Backup -Encoding UTF8
& powercfg /change standby-timeout-ac 0
if ($LASTEXITCODE -ne 0) { throw "关闭交流电休眠失败。" }
Write-Host "交流电休眠已设为永不；原设置保存在 $Backup"
