$ErrorActionPreference = "Stop"
$SshKeygen = (Get-Command ssh-keygen -ErrorAction Stop).Source
$StateRoot = Join-Path $env:LOCALAPPDATA "AgentPocket\tunnel"
$KeyFile = Join-Path $StateRoot "id_ed25519"
$PublicKeyFile = "$KeyFile.pub"
$Account = "$env:USERDOMAIN\$env:USERNAME"

New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
& icacls.exe $StateRoot /inheritance:r /grant:r "$Account`:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

if (-not (Test-Path -LiteralPath $KeyFile)) {
    & $SshKeygen -q -t ed25519 -N "" -C "agent-pocket-tunnel" -f $KeyFile
    if ($LASTEXITCODE -ne 0) { throw "ssh-keygen failed." }
}
if (-not (Test-Path -LiteralPath $PublicKeyFile)) {
    $PublicKey = & $SshKeygen -y -f $KeyFile
    if ($LASTEXITCODE -ne 0) { throw "Unable to derive the tunnel public key." }
    [System.IO.File]::WriteAllText($PublicKeyFile, "$PublicKey`n", (New-Object System.Text.UTF8Encoding $false))
}

& icacls.exe $KeyFile /inheritance:r /grant:r "$Account`:F" "SYSTEM:F" | Out-Null
Write-Host "Agent Pocket tunnel public key:"
Get-Content -Raw -Encoding UTF8 -LiteralPath $PublicKeyFile
Write-Host "Private key kept at $KeyFile"
