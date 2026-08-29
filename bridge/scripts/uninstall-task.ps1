$ErrorActionPreference = "Stop"
$ProcessUtils = Join-Path $PSScriptRoot "process-utils.ps1"
. $ProcessUtils
$StateRoot = Join-Path $env:LOCALAPPDATA "AgentPocket"
$InstallFile = Join-Path $StateRoot "installed.json"
$PidFile = Join-Path $StateRoot "bridge.pid"
$Install = if (Test-Path -LiteralPath $InstallFile) { Get-Content -Raw -Encoding UTF8 -LiteralPath $InstallFile | ConvertFrom-Json } else { $null }

$task = Get-ScheduledTask -TaskName "Agent Pocket Bridge" -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName "Agent Pocket Bridge" -ErrorAction SilentlyContinue
}
if ($Install) { Stop-AgentPocketInstalledBridge -Install $Install -PidFile $PidFile }
if ($task) { Unregister-ScheduledTask -TaskName "Agent Pocket Bridge" -Confirm:$false }
Write-Host "Agent Pocket Bridge logon task removed. Device database and logs were kept."
