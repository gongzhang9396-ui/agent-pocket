param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [switch]$Interactive
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'task-names.ps1')

$stateDir = Join-Path $env:LOCALAPPDATA 'AgentPocket'
$policyPath = Join-Path $InstallDir 'update-policy.json'
$updateDir = Join-Path $stateDir 'updates'
$runtimePath = Join-Path $stateDir 'host-runtime.json'
$maintenancePath = Join-Path $stateDir 'host-maintenance.json'
$node = Join-Path $InstallDir 'node\node.exe'
$entry = Join-Path $InstallDir 'bridge\src\cli.ts'
$utf8 = New-Object System.Text.UTF8Encoding $false
$maintenanceCreated = $false
$hostStopped = $false
$backupCreated = $false
$updateSucceeded = $false
$backupDir = Join-Path $stateDir 'update-rollback\host'
$backupHashes = @{}

function Show-AgentPocketMessage([string]$Text, [string]$Title, [bool]$Confirm = $false) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $buttons = if ($Confirm) { [System.Windows.Forms.MessageBoxButtons]::YesNo } else { [System.Windows.Forms.MessageBoxButtons]::OK }
        $icon = if ($Confirm) { [System.Windows.Forms.MessageBoxIcon]::Information } else { [System.Windows.Forms.MessageBoxIcon]::Warning }
        $choice = [System.Windows.Forms.MessageBox]::Show($Text, $Title, $buttons, $icon)
        return (-not $Confirm) -or $choice -eq [System.Windows.Forms.DialogResult]::Yes
    }
    catch {
        if (-not $Confirm) { Write-Warning $Text }
        return $false
    }
}

function Read-RuntimeStatus {
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $runtimePath | ConvertFrom-Json }
    catch { return $null }
}

function Test-FreshStatus($Status) {
    if (-not $Status -or -not $Status.updatedAt) { return $false }
    try {
        $age = [DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$Status.updatedAt)
        return $age.TotalSeconds -ge -5 -and $age.TotalSeconds -le 15
    }
    catch { return $false }
}

try {
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $policyPath -PathType Leaf)) {
        throw 'Host 更新组件不完整，请重新运行安装器。'
    }
    $rawResult = & $node --experimental-strip-types $entry host-update-check --policy $policyPath --output $updateDir
    if ($LASTEXITCODE -ne 0) { throw 'Host 更新检查失败。' }
    $result = ($rawResult | Select-Object -Last 1) | ConvertFrom-Json
    if ($result.status -ne 'ready') { return }

    if ($Interactive) {
        $approved = Show-AgentPocketMessage "Agent Pocket Host $($result.version) 已下载并通过签名校验。现在更新会短暂断开手机连接，是否继续？" 'Agent Pocket Host 更新' $true
        if (-not $approved) { return }
    }

    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $requestId = [Guid]::NewGuid().ToString('N')
    $expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeMilliseconds()
    $maintenanceTemp = "$maintenancePath.$PID.tmp"
    [IO.File]::WriteAllText($maintenanceTemp, (@{ version = 1; requestId = $requestId; expiresAt = $expiresAt } | ConvertTo-Json -Compress), $utf8)
    Move-Item -Force -LiteralPath $maintenanceTemp -Destination $maintenancePath
    $maintenanceCreated = $true

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    $status = $null
    do {
        Start-Sleep -Milliseconds 500
        $status = Read-RuntimeStatus
        if ((Test-FreshStatus $status) -and $status.running -eq $true -and $status.maintenance -eq $true -and $status.maintenanceRequestId -eq $requestId) { break }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if (-not (Test-FreshStatus $status) -or $status.running -ne $true -or $status.maintenance -ne $true -or $status.maintenanceRequestId -ne $requestId) {
        throw 'Host 没有确认维护模式，已取消更新。'
    }

    $status = Read-RuntimeStatus
    if (-not (Test-FreshStatus $status) -or [int]$status.activeTaskCount -ne 0) {
        if ($Interactive) {
            Show-AgentPocketMessage '当前仍有 Codex 任务在运行，本次不会强制更新。任务结束后将由每日检查或下次通知继续更新。' 'Agent Pocket Host 更新'
        }
        return
    }

    $expectedRoot = [IO.Path]::GetFullPath($updateDir).TrimEnd('\') + '\'
    $installer = [IO.Path]::GetFullPath([string]$result.file)
    if (-not $installer.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw '已验证的 Host 安装包路径无效。'
    }
    $fileInfo = Get-Item -LiteralPath $installer
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
    if ($fileInfo.Length -ne [long]$result.size -or $actualHash -ne ([string]$result.sha256).ToLowerInvariant()) {
        throw 'Host 安装包在启动前校验失败。'
    }

    $statePrefix = [IO.Path]::GetFullPath($stateDir).TrimEnd('\') + '\'
    $resolvedBackup = [IO.Path]::GetFullPath($backupDir)
    if (-not $resolvedBackup.StartsWith($statePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Host 回滚目录不安全。'
    }
    if (Test-Path -LiteralPath $resolvedBackup) { Remove-Item -LiteralPath $resolvedBackup -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $resolvedBackup | Out-Null
    Get-ChildItem -LiteralPath $InstallDir -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $resolvedBackup -Recurse -Force
    }
    Get-ChildItem -LiteralPath $resolvedBackup -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($resolvedBackup.TrimEnd('\').Length + 1)
        $backupHashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
    }
    if ($backupHashes.Count -eq 0) { throw 'Host 回滚备份为空。' }
    $backupCreated = $true

    Stop-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction Stop
    $hostStopped = $true
    $hostPid = [int]$status.pid
    $stopDeadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    while ($hostPid -gt 0 -and (Get-Process -Id $hostPid -ErrorAction SilentlyContinue) -and [DateTimeOffset]::UtcNow -lt $stopDeadline) {
        Start-Sleep -Milliseconds 250
    }
    if ($hostPid -gt 0 -and (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)) {
        throw 'Host 未能及时停止，已取消更新。'
    }

    $process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Host 安装器退出码为 $($process.ExitCode)。" }
    $updateSucceeded = $true
}
catch {
    $updateError = $_.Exception.Message
    if ($backupCreated -and -not $updateSucceeded) {
        try {
            $installRoot = [IO.Path]::GetFullPath($InstallDir)
            $installRootPath = [IO.Path]::GetPathRoot($installRoot)
            if ($installRoot.Equals($installRootPath, [StringComparison]::OrdinalIgnoreCase) -or
                $installRoot.Length -le ($installRootPath.Length + 8) -or
                -not (Test-Path -LiteralPath (Join-Path $backupDir 'node\node.exe') -PathType Leaf) -or
                -not (Test-Path -LiteralPath (Join-Path $backupDir 'bridge') -PathType Container)) {
                throw '拒绝恢复到未经验证的安装目录。'
            }
            $backupFiles = @(Get-ChildItem -LiteralPath $backupDir -Recurse -File)
            if ($backupFiles.Count -ne $backupHashes.Count) { throw 'Host 回滚备份文件数量已变化。' }
            foreach ($backupFile in $backupFiles) {
                $relative = $backupFile.FullName.Substring(([IO.Path]::GetFullPath($backupDir)).TrimEnd('\').Length + 1)
                if (-not $backupHashes.ContainsKey($relative) -or
                    (Get-FileHash -Algorithm SHA256 -LiteralPath $backupFile.FullName).Hash -ne $backupHashes[$relative]) {
                    throw "Host 回滚备份校验失败：$relative"
                }
            }
            $restoreDir = "$installRoot.rollback-$PID"
            $failedDir = "$installRoot.failed-$PID"
            foreach ($path in @($restoreDir, $failedDir)) {
                $resolved = [IO.Path]::GetFullPath($path)
                if (-not ([IO.Path]::GetDirectoryName($resolved)).Equals([IO.Path]::GetDirectoryName($installRoot), [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Host 回滚暂存目录不安全。'
                }
                if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
            }
            New-Item -ItemType Directory -Path $restoreDir | Out-Null
            Get-ChildItem -LiteralPath $backupDir -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $restoreDir -Recurse -Force }
            if (Test-Path -LiteralPath $installRoot) { Move-Item -LiteralPath $installRoot -Destination $failedDir }
            Move-Item -LiteralPath $restoreDir -Destination $installRoot
            if (Test-Path -LiteralPath $failedDir) { Remove-Item -LiteralPath $failedDir -Recurse -Force }
        } catch {
            if ($Interactive) { Show-AgentPocketMessage "自动回滚失败：$($_.Exception.Message)" 'Agent Pocket Host 更新失败' }
        }
    }
    if ($Interactive) { Show-AgentPocketMessage $updateError 'Agent Pocket Host 更新失败' }
    throw
}
finally {
    if ($maintenanceCreated) { Remove-Item -Force -LiteralPath $maintenancePath -ErrorAction SilentlyContinue }
    if ($hostStopped) { Start-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction SilentlyContinue }
    if ($updateSucceeded -and $backupCreated) { Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue }
}
