$ErrorActionPreference = "Continue"
$StateRoot = Join-Path $env:LOCALAPPDATA "AgentPocket\tunnel"
$ConfigFile = Join-Path $StateRoot "tunnel.json"
$KeyFile = Join-Path $StateRoot "id_ed25519"
$KnownHostsFile = Join-Path $StateRoot "known_hosts"
$Ssh = (Get-Command ssh -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $ConfigFile)) { throw "Tunnel configuration is missing." }
if (-not (Test-Path -LiteralPath $KeyFile)) { throw "Tunnel private key is missing." }
if (-not (Test-Path -LiteralPath $KnownHostsFile)) { throw "Tunnel known_hosts is missing." }

$Config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigFile | ConvertFrom-Json
$User = [string]$Config.user
$HostName = [string]$Config.hostName
$SshPort = [int]$Config.sshPort
$RemotePort = [int]$Config.remotePort
$LocalPort = [int]$Config.localPort
if ($User -notmatch "^[a-z_][a-z0-9_-]*$" -or $HostName -notmatch "^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$|^[A-Za-z0-9]$" -or $SshPort -lt 1 -or $SshPort -gt 65535 -or $RemotePort -lt 1024 -or $RemotePort -gt 65535 -or $LocalPort -lt 1 -or $LocalPort -gt 65535) {
    throw "Tunnel configuration is invalid."
}

$Arguments = @(
    "-NT",
    "-p", [string]$SshPort,
    "-i", $KeyFile,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=25",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=$KnownHostsFile",
    "-o", "LogLevel=ERROR",
    "-R", "127.0.0.1:$($RemotePort):127.0.0.1:$($LocalPort)",
    "$User@$HostName"
)

$delay = 5
while ($true) {
    & $Ssh @Arguments
    $exitCode = $LASTEXITCODE
    Start-Sleep -Seconds $delay
    if ($exitCode -eq 0) {
        $delay = 5
    } else {
        $delay = [Math]::Min($delay * 2, 60)
    }
}
