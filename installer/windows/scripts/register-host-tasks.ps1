param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [switch]$OnlyIfMissing,
    [switch]$StartHost
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'task-names.ps1')

$legacy = Get-ScheduledTask -TaskName 'Agent Pocket Host v2' -ErrorAction SilentlyContinue
if ($legacy -and ([string]$legacy.Actions.Arguments).IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Stop-ScheduledTask -TaskName 'Agent Pocket Host v2' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'Agent Pocket Host v2' -Confirm:$false -ErrorAction SilentlyContinue
}

$runner = Join-Path $InstallDir 'scripts\run-host.ps1'
$hostAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$hostTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$hostSettings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$existingHostTask = Get-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction SilentlyContinue
$hostTaskMatches = $existingHostTask -and ([string]$existingHostTask.Actions.Arguments).IndexOf($runner, [StringComparison]::OrdinalIgnoreCase) -ge 0
if (-not $OnlyIfMissing -or -not $hostTaskMatches) {
    Register-ScheduledTask -TaskName $AgentPocketHostTaskName -Action $hostAction -Trigger $hostTrigger -Settings $hostSettings -Description 'Agent Pocket Relay v2 Windows Host' -Force | Out-Null
}

$updater = Join-Path $InstallDir 'scripts\check-host-update.ps1'
$updateAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$updater`" -InstallDir `"$InstallDir`""
$updateTrigger = New-ScheduledTaskTrigger -Daily -At '12:00' -RandomDelay (New-TimeSpan -Hours 2)
$updateSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -StartWhenAvailable
$existingUpdateTask = Get-ScheduledTask -TaskName $AgentPocketUpdateTaskName -ErrorAction SilentlyContinue
$updateTaskMatches = $existingUpdateTask -and ([string]$existingUpdateTask.Actions.Arguments).IndexOf($updater, [StringComparison]::OrdinalIgnoreCase) -ge 0
if (-not $OnlyIfMissing -or -not $updateTaskMatches) {
    Register-ScheduledTask -TaskName $AgentPocketUpdateTaskName -Action $updateAction -Trigger $updateTrigger -Settings $updateSettings -Description 'Agent Pocket Host signed update check' -Force | Out-Null
}

if ($StartHost) {
    Stop-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction Stop
}
