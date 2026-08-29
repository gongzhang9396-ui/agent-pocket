$ErrorActionPreference = "Stop"
$AndroidRoot = Split-Path -Parent $PSScriptRoot
$SigningDir = Join-Path $env:LOCALAPPDATA "AgentPocket\signing"
$StoreFile = Join-Path $SigningDir "release.jks"
$PasswordFile = Join-Path $SigningDir "release-password.clixml"
$LegacyFile = Join-Path $SigningDir "keystore.properties"
$AppProperties = Join-Path $AndroidRoot "keystore.properties"
$KeyAlias = "agent-pocket"

$Keytool = $null
if ($env:JAVA_HOME) {
    $candidate = Join-Path $env:JAVA_HOME "bin\keytool.exe"
    if (Test-Path -LiteralPath $candidate) { $Keytool = $candidate }
}
if (-not $Keytool) {
    $command = Get-Command keytool -ErrorAction SilentlyContinue
    if ($command) { $Keytool = $command.Source }
}
if (-not $Keytool) { throw "keytool.exe not found. Install JDK 17 or newer." }

New-Item -ItemType Directory -Force -Path $SigningDir | Out-Null
$Account = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $SigningDir /inheritance:r /grant:r "$Account`:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

$PlainPassword = $null
try {
    if (Test-Path -LiteralPath $PasswordFile) {
        $SecurePassword = Import-Clixml -LiteralPath $PasswordFile
    } elseif (Test-Path -LiteralPath $LegacyFile) {
        $Legacy = ConvertFrom-StringData (Get-Content -Raw -LiteralPath $LegacyFile)
        $PlainPassword = [string]$Legacy.storePassword
        if (-not $PlainPassword) { throw "Legacy signing properties do not contain storePassword." }
        $SecurePassword = ConvertTo-SecureString $PlainPassword -AsPlainText -Force
        $SecurePassword | Export-Clixml -LiteralPath $PasswordFile
        $SecurePassword = Import-Clixml -LiteralPath $PasswordFile
        if (-not ($SecurePassword -is [System.Security.SecureString])) { throw "DPAPI password verification failed." }
        Remove-Item -LiteralPath $LegacyFile -Force
        Write-Host "Migrated the legacy plaintext signing password to Windows DPAPI."
    } elseif (Test-Path -LiteralPath $StoreFile) {
        throw "The signing key exists but its DPAPI password is missing. Restore release-password.clixml."
    } else {
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $PlainPassword = [Convert]::ToBase64String($bytes)
        $SecurePassword = ConvertTo-SecureString $PlainPassword -AsPlainText -Force
        $env:AGENT_POCKET_STORE_PASSWORD = $PlainPassword
        $env:AGENT_POCKET_KEY_PASSWORD = $PlainPassword
        & $Keytool -genkeypair -keystore $StoreFile -alias $KeyAlias -keyalg RSA -keysize 4096 -validity 10000 "-storepass:env" AGENT_POCKET_STORE_PASSWORD "-keypass:env" AGENT_POCKET_KEY_PASSWORD -dname "CN=Agent Pocket, OU=Private, O=Private, L=Private, ST=Private, C=CN"
        if ($LASTEXITCODE -ne 0) { throw "keytool failed to create the release key." }
        $SecurePassword | Export-Clixml -LiteralPath $PasswordFile
        $SecurePassword = Import-Clixml -LiteralPath $PasswordFile
        if (-not ($SecurePassword -is [System.Security.SecureString])) { throw "DPAPI password verification failed." }
        Write-Host "Created private signing key at $StoreFile"
    }

    if (-not (Test-Path -LiteralPath $StoreFile)) {
        throw "The DPAPI password exists but release.jks is missing. Restore both signing files together."
    }

    $storePath = $StoreFile -replace "\\", "/"
    "storeFile=$storePath`r`nkeyAlias=$KeyAlias`r`n" | Set-Content -LiteralPath $AppProperties -Encoding ASCII
    Write-Host "Release signing is ready. Back up release.jks and release-password.clixml together."
}
finally {
    Remove-Item Env:AGENT_POCKET_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_POCKET_KEY_PASSWORD -ErrorAction SilentlyContinue
    $PlainPassword = $null
}
