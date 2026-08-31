$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'task-names.ps1')
Stop-ScheduledTask -TaskName $AgentPocketHostTaskName
Stop-ScheduledTask -TaskName $AgentPocketUpdateTaskName
Unregister-ScheduledTask -TaskName $AgentPocketHostTaskName -Confirm:$false
Unregister-ScheduledTask -TaskName $AgentPocketUpdateTaskName -Confirm:$false
# Relay identity, Bridge SQLite and Codex history deliberately remain under
# %LOCALAPPDATA%\AgentPocket so reinstall and rollback do not destroy user data.
