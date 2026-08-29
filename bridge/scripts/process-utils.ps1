function Get-AgentPocketListenerProcessId {
    foreach ($line in (& netstat.exe -ano -p tcp)) {
        if ($line -match "127\.0\.0\.1:8787\s+\S+\s+LISTENING\s+(\d+)") {
            return [int]$Matches[1]
        }
    }
    return 0
}

function Test-AgentPocketBridgeProcess {
    param(
        [int]$ProcessId,
        [object]$Install
    )

    if ($ProcessId -le 0 -or -not $Install -or -not $Install.node -or -not $Install.bridgeRoot) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.ExecutablePath -or -not $process.CommandLine) { return $false }

    $expectedNode = [System.IO.Path]::GetFullPath([string]$Install.node)
    $expectedCli = Join-Path ([System.IO.Path]::GetFullPath([string]$Install.bridgeRoot)) "src\cli.ts"
    $sameNode = [string]::Equals($process.ExecutablePath, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase)
    $hasCli = $process.CommandLine.IndexOf('"' + $expectedCli + '"', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $hasServe = $process.CommandLine -match "(?:^|\s)serve(?:\s|$)"
    return $sameNode -and $hasCli -and $hasServe
}

function Stop-AgentPocketInstalledBridge {
    param(
        [object]$Install,
        [string]$PidFile,
        [switch]$FailOnForeignListener
    )

    $listenerId = Get-AgentPocketListenerProcessId
    $candidateIds = @()
    if (Test-Path -LiteralPath $PidFile) {
        $fileId = 0
        [void][int]::TryParse(((Get-Content -Raw -LiteralPath $PidFile).Trim()), [ref]$fileId)
        if ($fileId -gt 0) { $candidateIds += $fileId }
    }
    if ($listenerId -gt 0) { $candidateIds += $listenerId }

    foreach ($processId in ($candidateIds | Select-Object -Unique)) {
        if (Test-AgentPocketBridgeProcess -ProcessId $processId -Install $Install) {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        } elseif ($FailOnForeignListener -and $processId -eq $listenerId) {
            throw "Port 127.0.0.1:8787 is owned by another process; refusing to stop it."
        }
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
