$ErrorActionPreference = "Stop"
$TaskName = "Agent Pocket Tunnel"
$StateRoot = Join-Path $env:LOCALAPPDATA "AgentPocket\tunnel"
$ConfigFile = Join-Path $StateRoot "tunnel.json"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (Test-Path -LiteralPath $ConfigFile) {
    $Config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigFile | ConvertFrom-Json
    $CurrentUrl = [Environment]::GetEnvironmentVariable("AGENT_POCKET_WSS_URL", "User")
    if ([string]::Equals([string]$Config.publicUrl, $CurrentUrl, [StringComparison]::OrdinalIgnoreCase)) {
        [Environment]::SetEnvironmentVariable("AGENT_POCKET_WSS_URL", $null, "User")
    }
}
Write-Host "Agent Pocket SSH tunnel task removed. Tunnel keys and config were kept."
Write-Host "No Windows proxy settings were read or changed."
