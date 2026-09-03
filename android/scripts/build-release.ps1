param(
    [string]$DefaultRelayUrl = $env:AGENT_POCKET_DEFAULT_RELAY_URL,
    [string]$UpdatePublicKeySpki = $env:AGENT_POCKET_UPDATE_PUBLIC_KEY_SPKI
)
$ErrorActionPreference = "Stop"
$AndroidRoot = Split-Path -Parent $PSScriptRoot
$PasswordFile = Join-Path $env:LOCALAPPDATA "AgentPocket\signing\release-password.clixml"
$PropertiesFile = Join-Path $AndroidRoot "keystore.properties"
$ConfigurationCache = Join-Path $AndroidRoot ".gradle\configuration-cache"

if (-not [string]::IsNullOrWhiteSpace($DefaultRelayUrl)) {
    $DefaultRelayUrl = $DefaultRelayUrl.Trim().TrimEnd('/')
    try { $DefaultRelayUri = [Uri]$DefaultRelayUrl } catch { throw "DefaultRelayUrl must be a valid HTTPS URL." }
    if (-not $DefaultRelayUri.IsAbsoluteUri -or $DefaultRelayUri.Scheme -ne 'https' -or
        -not $DefaultRelayUri.Host -or $DefaultRelayUri.UserInfo -or $DefaultRelayUri.Query -or
        $DefaultRelayUri.Fragment) {
        throw "DefaultRelayUrl must be a credential-free HTTPS URL without query or fragment."
    }
}

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
    $GradleArgs = @('--no-daemon', '--no-configuration-cache')
    if ($DefaultRelayUrl) { $GradleArgs += "-PagentPocketDefaultRelayUrl=$DefaultRelayUrl" }
    if ($UpdatePublicKeySpki) { $GradleArgs += "-PagentPocketUpdatePublicKeySpki=$UpdatePublicKeySpki" }
    $GradleArgs += ':app:assembleRelease'
    try { & .\gradlew.bat @GradleArgs } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Gradle release build failed." }

    $ReleaseDirectory = Join-Path $AndroidRoot "app\build\outputs\apk\release"
    $MetadataFile = Join-Path $ReleaseDirectory "output-metadata.json"
    if (-not (Test-Path -LiteralPath $MetadataFile)) { throw "Release metadata is missing." }
    $Metadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $MetadataFile | ConvertFrom-Json
    $Element = $Metadata.elements | Select-Object -First 1
    $VersionName = [string]$Element.versionName
    $SourceApk = Join-Path $ReleaseDirectory ([string]$Element.outputFile)
    if (-not $VersionName -or -not (Test-Path -LiteralPath $SourceApk)) { throw "Release APK metadata is incomplete." }
    $MappingFile = Join-Path $AndroidRoot "app\build\outputs\mapping\release\mapping.txt"
    if (-not (Test-Path -LiteralPath $MappingFile)) { throw "Release R8 mapping is missing." }
    $Mapping = Get-Content -LiteralPath $MappingFile
    foreach ($RequiredMapping in @(
        "com.sun.jna.Pointer -> com.sun.jna.Pointer:",
        "com.goterl.lazysodium.SodiumAndroid -> com.goterl.lazysodium.SodiumAndroid:"
    )) {
        if ($Mapping -cnotcontains $RequiredMapping) {
            throw "Release R8 mapping changed a native binding symbol: $RequiredMapping"
        }
    }
    $SeedsFile = Join-Path $AndroidRoot "app\build\outputs\mapping\release\seeds.txt"
    if (-not (Test-Path -LiteralPath $SeedsFile) -or
        (Get-Content -LiteralPath $SeedsFile) -cnotcontains "com.sun.jna.Pointer: long peer") {
        throw "Release R8 removed the JNA Pointer.peer native binding field."
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [System.IO.Compression.ZipFile]::OpenRead($SourceApk)
    try {
        $Entries = @($Archive.Entries | ForEach-Object FullName)
        foreach ($RequiredEntry in @(
            "lib/arm64-v8a/libjnidispatch.so",
            "lib/arm64-v8a/libsodium.so"
        )) {
            if ($Entries -notcontains $RequiredEntry) {
                throw "Release APK is missing required Android native library: $RequiredEntry"
            }
        }
    }
    finally {
        $Archive.Dispose()
    }
    $ReleaseName = "Agent-Pocket-$VersionName-release.apk"
    $ReleaseApk = Join-Path $ReleaseDirectory $ReleaseName
    Copy-Item -Force -LiteralPath $SourceApk -Destination $ReleaseApk
    $Checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $ReleaseApk).Hash.ToLowerInvariant()
    $Utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText("$ReleaseApk.sha256", "$Checksum  $ReleaseName`n", $Utf8)
    Write-Host "Release APK: $ReleaseApk"
    Write-Host "Checksum: $ReleaseApk.sha256"
}
finally {
    Remove-Item Env:AGENT_POCKET_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_POCKET_KEY_PASSWORD -ErrorAction SilentlyContinue
    $PlainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
    Remove-Item -LiteralPath $ConfigurationCache -Recurse -Force -ErrorAction SilentlyContinue
}
