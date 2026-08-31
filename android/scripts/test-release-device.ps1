[CmdletBinding()]
param(
    [string]$Serial
)

$ErrorActionPreference = "Stop"
$AndroidRoot = Split-Path -Parent $PSScriptRoot
$PasswordFile = Join-Path $env:LOCALAPPDATA "AgentPocket\signing\release-password.clixml"
$PropertiesFile = Join-Path $AndroidRoot "keystore.properties"
$TestApk = Join-Path $AndroidRoot "app\build\outputs\apk\androidTest\release\app-release-androidTest.apk"
$ConfigurationCache = Join-Path $AndroidRoot ".gradle\configuration-cache"
$TestPackage = "com.agentpocket.app.test"
$TestInstalled = $false

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    throw "adb is not available on PATH."
}
if (-not (Test-Path -LiteralPath $PasswordFile) -or -not (Test-Path -LiteralPath $PropertiesFile)) {
    throw "Release signing material is missing. Run scripts/create-release-key.ps1 first."
}

if (-not $Serial) {
    $Devices = @(& adb devices | Select-String '^([^\s]+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
    if ($Devices.Count -ne 1) {
        throw "Expected one connected Android device, found $($Devices.Count). Pass -Serial explicitly."
    }
    $Serial = $Devices[0]
}
$AdbTarget = @("-s", $Serial)

function Invoke-Adb {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $Output = @(& adb @AdbTarget @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "adb $($Arguments -join ' ') failed:`n$($Output -join "`n")"
    }
    return $Output
}

$SecurePassword = Import-Clixml -LiteralPath $PasswordFile
$PasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
try {
    $PlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($PasswordPointer)
    $env:AGENT_POCKET_STORE_PASSWORD = $PlainPassword
    $env:AGENT_POCKET_KEY_PASSWORD = $PlainPassword

    Push-Location $AndroidRoot
    try {
        & .\gradlew.bat --no-daemon --no-configuration-cache :app:assembleReleaseAndroidTest
        if ($LASTEXITCODE -ne 0) { throw "Gradle release AndroidTest build failed." }
    }
    finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $TestApk)) { throw "Release AndroidTest APK is missing." }

    Invoke-Adb -Arguments @("install", "-r", "-t", $TestApk) | Write-Host
    $TestInstalled = $true

    $NativeOutput = Invoke-Adb -Arguments @(
        "shell", "am", "instrument", "-w",
        "$TestPackage/com.agentpocket.app.data.ReleaseNativeCryptoInstrumentation"
    )
    $NativeOutput | Write-Host
    if (($NativeOutput -join "`n") -notmatch "JNA native checks and all relay crypto vectors passed") {
        throw "Release native crypto instrumentation did not report success."
    }
}
finally {
    if ($TestInstalled) {
        & adb @AdbTarget uninstall $TestPackage | Out-Null
    }
    Remove-Item Env:AGENT_POCKET_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_POCKET_KEY_PASSWORD -ErrorAction SilentlyContinue
    $PlainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($PasswordPointer)
    Remove-Item -LiteralPath $ConfigurationCache -Recurse -Force -ErrorAction SilentlyContinue
}
