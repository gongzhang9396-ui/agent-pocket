$ErrorActionPreference = "Stop"
$BridgeRoot = Split-Path -Parent $PSScriptRoot
$ProcessUtils = Join-Path $PSScriptRoot "process-utils.ps1"
. $ProcessUtils

function Resolve-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
    throw "node.exe not found. Install Node.js 24 and add it to PATH."
}

function Resolve-Codex {
    if ($env:AGENT_POCKET_CODEX -and (Test-Path -LiteralPath $env:AGENT_POCKET_CODEX)) {
        return (Resolve-Path -LiteralPath $env:AGENT_POCKET_CODEX).Path
    }
    $command = Get-Command codex -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
    $codexRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $codexRoot) {
        $found = Get-ChildItem -LiteralPath $codexRoot -Recurse -Filter "codex.exe" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    throw "codex.exe not found. Install Codex CLI or set AGENT_POCKET_CODEX."
}

$Node = Resolve-Node
$Codex = Resolve-Codex
$Version = [version](((& $Node --version).TrimStart("v")).Split("-")[0])
if ($Version.Major -lt 24) { throw "Agent Pocket requires Node.js 24 or newer." }

$StateRoot = Join-Path $env:LOCALAPPDATA "AgentPocket"
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
$Account = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $StateRoot /inheritance:r /grant:r "$Account`:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
$InstallFile = Join-Path $StateRoot "installed.json"
$PidFile = Join-Path $StateRoot "bridge.pid"
$OldInstall = if (Test-Path -LiteralPath $InstallFile) { Get-Content -Raw -Encoding UTF8 -LiteralPath $InstallFile | ConvertFrom-Json } else { $null }

$ExistingTask = Get-ScheduledTask -TaskName "Agent Pocket Bridge" -ErrorAction SilentlyContinue
if ($ExistingTask) { Stop-ScheduledTask -TaskName "Agent Pocket Bridge" -ErrorAction SilentlyContinue }
if ($OldInstall) {
    Stop-AgentPocketInstalledBridge -Install $OldInstall -PidFile $PidFile -FailOnForeignListener
} elseif ((Get-AgentPocketListenerProcessId) -gt 0) {
    throw "Port 127.0.0.1:8787 is already in use and no prior install state can prove ownership."
}

Push-Location $BridgeRoot
try { & npm install --omit=dev --ignore-scripts } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

$InstallJson = @{ node = $Node; codex = $Codex; bridgeRoot = $BridgeRoot } | ConvertTo-Json
[System.IO.File]::WriteAllText($InstallFile, $InstallJson, (New-Object System.Text.UTF8Encoding $false))

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'run-bridge.ps1')`"" `
    -WorkingDirectory $BridgeRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "Agent Pocket Bridge" -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
Start-ScheduledTask -TaskName "Agent Pocket Bridge"
Write-Host "Agent Pocket Bridge installed and started."
Write-Host "Node: $Node"
Write-Host "Codex: $Codex"
Write-Host "Bridge: $BridgeRoot"
