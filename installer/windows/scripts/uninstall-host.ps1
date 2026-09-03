param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [switch]$RemoveUserData
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'task-names.ps1')

$script:UninstallLogPath = Join-Path ([IO.Path]::GetTempPath()) 'AgentPocket-uninstall.log'
$script:UninstallFailures = New-Object 'System.Collections.Generic.List[string]'

function Write-UninstallLog([string]$Message) {
    try {
        $line = '{0:u} {1}{2}' -f (Get-Date), $Message, [Environment]::NewLine
        [IO.File]::AppendAllText($script:UninstallLogPath, $line, [Text.UTF8Encoding]::new($false))
    }
    catch {
        # Logging must never prevent the uninstall itself.
    }
}

function Add-UninstallFailure([string]$Step, [System.Management.Automation.ErrorRecord]$Failure) {
    $message = '{0}: {1}' -f $Step, $Failure.Exception.Message
    [void]$script:UninstallFailures.Add($message)
    Write-UninstallLog "ERROR $message"
}

function Normalize-LocalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $candidate = $Path
    if ($candidate.StartsWith('\\?\')) { $candidate = $candidate.Substring(4) }
    return [IO.Path]::GetFullPath($candidate).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-SamePath([string]$Left, [string]$Right) {
    return [StringComparer]::OrdinalIgnoreCase.Equals(
        (Normalize-LocalPath $Left),
        (Normalize-LocalPath $Right)
    )
}

function Test-ContainsPath([string]$CommandLine, [string]$ExpectedPath) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    return $CommandLine.IndexOf($ExpectedPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Remove-AgentPocketScheduledTasks {
    $taskNames = @(
        $AgentPocketHostTaskName,
        $AgentPocketUpdateTaskName,
        $AgentPocketLegacyHostTaskName
    ) | Select-Object -Unique

    foreach ($taskName in $taskNames) {
        try {
            $tasks = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
        }
        catch {
            Add-UninstallFailure "Read scheduled task '$taskName'" $_
            continue
        }
        foreach ($task in $tasks) {
            if ([string]$task.State -eq 'Running') {
                try {
                    Stop-ScheduledTask -InputObject $task -ErrorAction Stop
                }
                catch {
                    Add-UninstallFailure "Stop scheduled task '$taskName'" $_
                }
            }
            try {
                Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop
                Write-UninstallLog "Removed scheduled task '$taskName'."
            }
            catch {
                Add-UninstallFailure "Unregister scheduled task '$taskName'" $_
            }
        }
    }
}

function Stop-AgentPocketProcesses([string]$NormalizedInstallDir) {
    $hostExecutable = Normalize-LocalPath (Join-Path $NormalizedInstallDir 'node\node.exe')
    $bridgeCli = Normalize-LocalPath (Join-Path $NormalizedInstallDir 'bridge\src\cli.ts')
    $desktopAttachServer = Normalize-LocalPath (Join-Path $NormalizedInstallDir 'marketplace\plugins\agent-pocket-desktop-attach\server.mjs')

    try {
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    }
    catch {
        Add-UninstallFailure 'Read running processes' $_
        return
    }

    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        $isHost = (Test-SamePath ([string]$process.ExecutablePath) $hostExecutable) -and
            (Test-ContainsPath $commandLine $bridgeCli) -and
            [Regex]::IsMatch($commandLine, '(^|\s)serve(\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $isDesktopAttach = (Test-ContainsPath $commandLine $desktopAttachServer) -and
            [Regex]::IsMatch($commandLine, '(^|\s)--bridge-host(\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)

        if (-not ($isHost -or $isDesktopAttach)) { continue }

        try {
            Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
            $kind = if ($isHost) { 'Host' } else { 'Desktop Attach' }
            Write-UninstallLog "Stopped validated $kind process PID $($process.ProcessId)."
        }
        catch {
            Add-UninstallFailure "Stop Agent Pocket process PID $($process.ProcessId)" $_
        }
    }
}

function Invoke-CodexJson([string[]]$Arguments, [string]$FailureMessage) {
    $output = @(& $script:CodexPath @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage（Codex CLI 退出代码 $LASTEXITCODE）。"
    }
    try {
        return (($output | Out-String) | ConvertFrom-Json)
    }
    catch {
        throw "$FailureMessage：Codex CLI 返回了无法识别的结果。"
    }
}

function Remove-DesktopAttachPlugin([string]$NormalizedInstallDir) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $codex) {
        Write-UninstallLog 'Codex CLI was not found; skipped Desktop Attach plugin deregistration.'
        return
    }
    $script:CodexPath = $codex.Source

    $marketplacePath = Normalize-LocalPath (Join-Path $NormalizedInstallDir 'marketplace')
    $marketplaces = Invoke-CodexJson -Arguments @('plugin', 'marketplace', 'list', '--json') -FailureMessage '读取 Codex Marketplace 失败'
    $marketplace = @($marketplaces.marketplaces) | Where-Object {
        (Test-SamePath ([string]$_.root) $marketplacePath)
    } | Select-Object -First 1

    if (-not $marketplace) {
        Write-UninstallLog 'No Codex marketplace matched the install directory.'
        return
    }

    $marketplaceName = [string]$marketplace.name
    if ([string]::IsNullOrWhiteSpace($marketplaceName)) {
        throw '匹配安装目录的 Codex Marketplace 没有名称。'
    }

    $pluginSelector = "agent-pocket-desktop-attach@$marketplaceName"
    $plugins = Invoke-CodexJson -Arguments @('plugin', 'list', '--json') -FailureMessage '读取 Codex 插件列表失败'
    $installed = @($plugins.installed) | Where-Object {
        [string]$_.pluginId -eq $pluginSelector
    } | Select-Object -First 1

    if ($installed) {
        try {
            [void](Invoke-CodexJson -Arguments @('plugin', 'remove', $pluginSelector, '--json') -FailureMessage '移除 Desktop Attach 插件失败')
            Write-UninstallLog "Removed Codex plugin '$pluginSelector'."
        }
        catch {
            # Codex Desktop can keep the plugin cache open. Removing the exact
            # marketplace below still disables the plugin; the cache is inert.
            Write-UninstallLog "WARNING Could not remove the active Codex plugin cache: $($_.Exception.Message)"
        }
    }

    [void](Invoke-CodexJson -Arguments @('plugin', 'marketplace', 'remove', $marketplaceName, '--json') -FailureMessage '移除 Agent Pocket Marketplace 失败')
    Write-UninstallLog "Removed Codex marketplace '$marketplaceName'."
}

function Remove-VolatileState([string]$StateRoot) {
    if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) { return }

    foreach ($name in @('desktop-attach.json', 'host-runtime.json', 'host-maintenance.json')) {
        $path = Join-Path $StateRoot $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        }
    }
    Get-ChildItem -LiteralPath $StateRoot -Filter 'pairing-*.png' -File -ErrorAction Stop |
        Remove-Item -Force -ErrorAction Stop
    Write-UninstallLog 'Removed volatile runtime registrations and pairing QR images.'
}

function Remove-LocalAccountData([string]$StateRoot, [string]$LocalAppDataRoot) {
    $normalizedStateRoot = Normalize-LocalPath $StateRoot
    $normalizedLocalAppData = Normalize-LocalPath $LocalAppDataRoot
    $stateParent = Normalize-LocalPath (Split-Path -Parent $normalizedStateRoot)
    $stateLeaf = Split-Path -Leaf $normalizedStateRoot

    if (-not (Test-SamePath $stateParent $normalizedLocalAppData) -or $stateLeaf -cne 'AgentPocket') {
        throw "拒绝删除未通过安全校验的状态目录：$normalizedStateRoot"
    }
    if (Test-Path -LiteralPath $normalizedStateRoot -PathType Container) {
        Remove-Item -LiteralPath $normalizedStateRoot -Recurse -Force -ErrorAction Stop
        Write-UninstallLog 'Removed the current Windows user AgentPocket state directory.'
    }
}

try {
    $normalizedInstallDir = Normalize-LocalPath $InstallDir
    if ([string]::IsNullOrWhiteSpace($normalizedInstallDir)) { throw '安装目录不能为空。' }
    if (Test-SamePath $normalizedInstallDir ([IO.Path]::GetPathRoot($normalizedInstallDir))) {
        throw '安装目录不能是磁盘根目录。'
    }
    $expectedScript = Normalize-LocalPath (Join-Path $normalizedInstallDir 'scripts\uninstall-host.ps1')
    if (-not (Test-SamePath $expectedScript $PSCommandPath)) {
        throw '卸载脚本必须从待卸载的 Agent Pocket Host 安装目录运行。'
    }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA 不可用。' }

    $localAppDataRoot = Normalize-LocalPath $env:LOCALAPPDATA
    $stateRoot = Normalize-LocalPath (Join-Path $localAppDataRoot 'AgentPocket')
    Write-UninstallLog "Starting Agent Pocket Host uninstall cleanup. RemoveUserData=$([bool]$RemoveUserData)."
}
catch {
    Add-UninstallFailure 'Validate uninstall paths' $_
    exit 1
}

Remove-AgentPocketScheduledTasks
Stop-AgentPocketProcesses $normalizedInstallDir

try {
    Remove-DesktopAttachPlugin $normalizedInstallDir
}
catch {
    Add-UninstallFailure 'Remove Desktop Attach plugin registration' $_
}

try {
    Remove-VolatileState $stateRoot
}
catch {
    Add-UninstallFailure 'Remove volatile Agent Pocket state' $_
}

if ($RemoveUserData) {
    try {
        Remove-LocalAccountData $stateRoot $localAppDataRoot
    }
    catch {
        Add-UninstallFailure 'Remove local account and binding data' $_
    }
}

if ($script:UninstallFailures.Count -gt 0) {
    Write-UninstallLog "Cleanup finished with $($script:UninstallFailures.Count) error(s)."
    exit 1
}

Write-UninstallLog 'Cleanup finished successfully.'
exit 0
