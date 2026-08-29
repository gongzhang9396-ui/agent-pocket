param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][string]$HostKeySha256,
    [Parameter(Mandatory = $true)][string]$PublicUrl,
    [string]$User = "agentpocket",
    [int]$SshPort = 22,
    [int]$RemotePort = 18787,
    [int]$LocalPort = 8787
)

$ErrorActionPreference = "Stop"
$TaskName = "Agent Pocket Tunnel"
$Ssh = (Get-Command ssh -ErrorAction Stop).Source
$SshKeyscan = (Get-Command ssh-keyscan -ErrorAction Stop).Source
$SshKeygen = (Get-Command ssh-keygen -ErrorAction Stop).Source
$StateRoot = Join-Path $env:LOCALAPPDATA "AgentPocket\tunnel"
$KeyFile = Join-Path $StateRoot "id_ed25519"
$KnownHostsFile = Join-Path $StateRoot "known_hosts"
$ConfigFile = Join-Path $StateRoot "tunnel.json"
$RunnerFile = Join-Path $PSScriptRoot "run-oci-tunnel.ps1"
$Account = "$env:USERDOMAIN\$env:USERNAME"

if ($HostName -notmatch "^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$" -and $HostName -notmatch "^[A-Za-z0-9]$") { throw "HostName contains unsupported characters." }
if ($User -notmatch "^[a-z_][a-z0-9_-]*$") { throw "User contains unsupported characters." }
if ($SshPort -lt 1 -or $SshPort -gt 65535) { throw "SshPort is invalid." }
if ($RemotePort -lt 1024 -or $RemotePort -gt 65535) { throw "RemotePort must be between 1024 and 65535." }
if ($LocalPort -lt 1 -or $LocalPort -gt 65535) { throw "LocalPort is invalid." }
$Endpoint = $null
if (-not [Uri]::TryCreate($PublicUrl, [UriKind]::Absolute, [ref]$Endpoint) -or $Endpoint.Scheme -ne "wss" -or -not $Endpoint.Host -or $Endpoint.UserInfo -or $Endpoint.Fragment) {
    throw "PublicUrl must be an absolute wss:// URL without user info or a fragment."
}
$ExpectedFingerprint = $HostKeySha256.Trim()
if ($ExpectedFingerprint -notmatch "^SHA256:[A-Za-z0-9+/]{43}$") { throw "HostKeySha256 must be an OpenSSH SHA256 fingerprint." }
if (-not (Test-Path -LiteralPath $KeyFile)) { throw "Tunnel key is missing. Run new-oci-tunnel-key.ps1 first." }

New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
& icacls.exe $StateRoot /inheritance:r /grant:r "$Account`:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

$TempKnownHosts = Join-Path $StateRoot "known_hosts.pending"
try {
    $ScannedKeys = & $SshKeyscan -T 10 -p $SshPort -t ed25519 $HostName 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $ScannedKeys) { throw "Unable to scan the OCI SSH host key." }
    [System.IO.File]::WriteAllLines($TempKnownHosts, [string[]]$ScannedKeys, (New-Object System.Text.UTF8Encoding $false))
    $FingerprintLine = (& $SshKeygen -lf $TempKnownHosts -E sha256 | Select-Object -First 1)
    $ActualFingerprint = ([regex]::Match([string]$FingerprintLine, "SHA256:[A-Za-z0-9+/]{43}")).Value
    if (-not [string]::Equals($ActualFingerprint, $ExpectedFingerprint, [StringComparison]::Ordinal)) {
        throw "OCI SSH host fingerprint mismatch. Expected $ExpectedFingerprint but received $ActualFingerprint."
    }
    Move-Item -LiteralPath $TempKnownHosts -Destination $KnownHostsFile -Force
} finally {
    Remove-Item -LiteralPath $TempKnownHosts -Force -ErrorAction SilentlyContinue
}

$ActionArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunnerFile`""
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $ActionArguments -WorkingDirectory $PSScriptRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null

$Config = @{
    hostName = $HostName
    sshPort = $SshPort
    user = $User
    remotePort = $RemotePort
    localPort = $LocalPort
    publicUrl = $Endpoint.AbsoluteUri
    hostKeySha256 = $ExpectedFingerprint
} | ConvertTo-Json
[System.IO.File]::WriteAllText($ConfigFile, $Config, (New-Object System.Text.UTF8Encoding $false))
[Environment]::SetEnvironmentVariable("AGENT_POCKET_WSS_URL", $Endpoint.AbsoluteUri, "User")
$env:AGENT_POCKET_WSS_URL = $Endpoint.AbsoluteUri
Start-ScheduledTask -TaskName $TaskName

Write-Host "Agent Pocket SSH tunnel task installed and started."
Write-Host "Public WSS endpoint saved without printing its private path."
Write-Host "Remote forwarding: 127.0.0.1:$RemotePort -> Windows 127.0.0.1:$LocalPort"
Write-Host "No Windows proxy settings were read or changed."
