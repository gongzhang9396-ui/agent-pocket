$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $env:LOCALAPPDATA 'AgentPocket\host-config.json'
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$env:AGENT_POCKET_RELAY_URL = [string]$config.relayUrl
$env:AGENT_POCKET_HOST_NAME = [string]$config.hostName
$env:AGENT_POCKET_RELAY_IDENTITY = Join-Path $env:LOCALAPPDATA 'AgentPocket\relay-host.json'
$node = Join-Path $installDir 'node\node.exe'
$entry = Join-Path $installDir 'bridge\src\cli.ts'
& $node --experimental-strip-types $entry relay-enroll $config.relayUrl
if ($LASTEXITCODE -ne 0) { throw "Host 绑定失败，退出码 $LASTEXITCODE" }
. (Join-Path $PSScriptRoot 'task-names.ps1')
Stop-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction SilentlyContinue
