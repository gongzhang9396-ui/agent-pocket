$ErrorActionPreference = "Stop"
$AndroidRoot = Split-Path -Parent $PSScriptRoot
$PasswordFile = Join-Path $env:LOCALAPPDATA "AgentPocket\signing\release-password.clixml"
$PropertiesFile = Join-Path $AndroidRoot "keystore.properties"
$ConfigurationCache = Join-Path $AndroidRoot ".gradle\configuration-cache"

if (-not (Test-Path -LiteralPath $PasswordFile) -or -not (Test-Path -LiteralPath $PropertiesFile)) {
    & (Join-Path $PSScriptRoot "create-release-key.ps1")
}

$SecurePassword = Import-Clixml -LiteralPath $PasswordFile
$Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
try {
    $PlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
    $env:AGENT_POCKET_STORE_PASSWORD = $PlainPassword
    $env:AGENT_POCKET_KEY_PASSWORD = $PlainPassword
    Push-Location $AndroidRoot
    try { & .\gradlew.bat --no-daemon --no-configuration-cache :app:assembleRelease } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Gradle release build failed." }
}
finally {
    Remove-Item Env:AGENT_POCKET_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_POCKET_KEY_PASSWORD -ErrorAction SilentlyContinue
    $PlainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
    Remove-Item -LiteralPath $ConfigurationCache -Recurse -Force -ErrorAction SilentlyContinue
}
