param(
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][string]$AdminUser,
    [Parameter(Mandatory = $true)][string]$AdminKey,
    [Parameter(Mandatory = $true)][string]$HostKeySha256,
    [int]$RemotePort = 18787
)

$ErrorActionPreference = "Stop"
$Scp = (Get-Command scp -ErrorAction Stop).Source
$Ssh = (Get-Command ssh -ErrorAction Stop).Source
$SshKeyscan = (Get-Command ssh-keyscan -ErrorAction Stop).Source
$SshKeygen = (Get-Command ssh-keygen -ErrorAction Stop).Source
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProvisionScript = Join-Path $ScriptRoot "provision-oci-relay.sh"
$InstallTunnelScript = Join-Path $ScriptRoot "install-oci-tunnel.ps1"
$TunnelRoot = Join-Path $env:LOCALAPPDATA "AgentPocket\tunnel"
$PublicKeyFile = Join-Path $TunnelRoot "id_ed25519.pub"
$RunId = [Guid]::NewGuid().ToString("N")
$RemoteScript = "/tmp/agent-pocket-$RunId.sh"
$RemoteKey = "/tmp/agent-pocket-$RunId.pub"
$Target = "$AdminUser@$HostName"
$PinnedKnownHosts = Join-Path $TunnelRoot "known_hosts.deploy.$RunId"

if ($Domain -notmatch "^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$" -and $Domain -notmatch "^[A-Za-z0-9]$") { throw "Domain contains unsupported characters." }
if ($HostName -notmatch "^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$" -and $HostName -notmatch "^[A-Za-z0-9]$") { throw "HostName contains unsupported characters." }
if ($AdminUser -notmatch "^[a-z_][a-z0-9_-]*$") { throw "AdminUser contains unsupported characters." }
if ($RemotePort -lt 1024 -or $RemotePort -gt 65535) { throw "RemotePort must be between 1024 and 65535." }
if ($HostKeySha256.Trim() -notmatch "^SHA256:[A-Za-z0-9+/]{43}$") { throw "HostKeySha256 must be an OpenSSH SHA256 fingerprint." }
if (-not (Test-Path -LiteralPath $AdminKey)) { throw "Relay admin SSH key is missing." }
if (-not (Test-Path -LiteralPath $PublicKeyFile)) { throw "Run new-oci-tunnel-key.ps1 first." }
if (-not (Test-Path -LiteralPath $ProvisionScript)) { throw "OCI provision script is missing." }

New-Item -ItemType Directory -Force -Path $TunnelRoot | Out-Null
$ScannedKeys = & $SshKeyscan -T 10 -p 22 -t ed25519 $HostName 2>$null
if ($LASTEXITCODE -ne 0 -or -not $ScannedKeys) { throw "Unable to scan the relay SSH host key." }
[System.IO.File]::WriteAllLines($PinnedKnownHosts, [string[]]$ScannedKeys, (New-Object System.Text.UTF8Encoding $false))
$FingerprintLine = (& $SshKeygen -lf $PinnedKnownHosts -E sha256 | Select-Object -First 1)
$ActualFingerprint = ([regex]::Match([string]$FingerprintLine, "SHA256:[A-Za-z0-9+/]{43}")).Value
if (-not [string]::Equals($ActualFingerprint, $HostKeySha256.Trim(), [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $PinnedKnownHosts -Force -ErrorAction SilentlyContinue
    throw "Relay SSH host fingerprint mismatch."
}

$CommonSsh = @(
    "-i", $AdminKey,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=$PinnedKnownHosts",
    "-o", "ConnectTimeout=10"
)

try {
    & $Scp @CommonSsh -- $ProvisionScript $PublicKeyFile "${Target}:/tmp/"
    if ($LASTEXITCODE -ne 0) { throw "Unable to upload the relay installer." }

    $UploadedScript = "/tmp/$(Split-Path -Leaf $ProvisionScript)"
    $UploadedKey = "/tmp/$(Split-Path -Leaf $PublicKeyFile)"
    & $Ssh @CommonSsh -- $Target "mv '$UploadedScript' '$RemoteScript' && mv '$UploadedKey' '$RemoteKey'"
    if ($LASTEXITCODE -ne 0) { throw "Unable to stage the relay installer." }

    $Output = & $Ssh @CommonSsh -- $Target "sudo bash '$RemoteScript' '$Domain' '$RemoteKey' '$RemotePort'"
    if ($LASTEXITCODE -ne 0) { throw "Relay provisioning failed." }
    $UrlLine = $Output | Where-Object { $_ -like "AGENT_POCKET_WSS_URL=*" } | Select-Object -Last 1
    if (-not $UrlLine) { throw "Relay provisioning did not return a public WSS URL." }
    $PublicUrl = $UrlLine.Substring("AGENT_POCKET_WSS_URL=".Length)

    & $InstallTunnelScript -HostName $HostName -HostKeySha256 $HostKeySha256 -PublicUrl $PublicUrl -RemotePort $RemotePort
    if ($LASTEXITCODE -ne 0) { throw "The relay was provisioned, but the Windows tunnel task failed to install." }

    Write-Host "Agent Pocket relay and Windows tunnel are ready."
    Write-Host "Public endpoint saved to the current user's Agent Pocket settings."
    Write-Host "The existing proxy and sing-box configuration were not changed."
} finally {
    & $Ssh @CommonSsh -- $Target "rm -f '$RemoteScript' '$RemoteKey'" 2>$null | Out-Null
    Remove-Item -LiteralPath $PinnedKnownHosts -Force -ErrorAction SilentlyContinue
}
