param(
    [Parameter(Mandatory=$true)][string]$SourceDigest,
    [Parameter(Mandatory=$true)][string]$ReferenceApk,
    [Parameter(Mandatory=$true)][int]$PublishedMaxVersionCode,
    [Parameter(Mandatory=$true)][string]$DefaultRelayUrl,
    [Parameter(Mandatory=$true)][string]$UpdatePublicKeySpki,
    [string]$Flutter = 'flutter',
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$BuildRoot = Split-Path -Parent $PSScriptRoot
if ($BuildRoot -match '[^\x00-\x7f]' -or $ReferenceApk -match '[^\x00-\x7f]') { throw 'Run this script and reference APK through ASCII paths/junctions; Android aapt cannot read non-ASCII Windows paths.' }
$MobileRoot = & node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' $BuildRoot
if ($LASTEXITCODE -ne 0 -or -not $MobileRoot) { throw 'Cannot resolve the original project directory.' }
$RepoRoot = Split-Path -Parent $MobileRoot
$VersionLine = [IO.File]::ReadAllText((Join-Path $MobileRoot 'pubspec.yaml'))
if ($VersionLine -notmatch '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)\s*$') { throw 'pubspec.yaml must declare a stable version and build number.' }
$VersionName = $Matches[1]
$DeclaredVersionCode = [int]$Matches[2]
$VersionCode = [Math]::Max($DeclaredVersionCode, [Math]::Max(400, $PublishedMaxVersionCode + 1))
if ($PublishedMaxVersionCode -lt 0 -or $VersionCode -le $PublishedMaxVersionCode) { throw 'Invalid published version code.' }
$Source = & node (Join-Path $PSScriptRoot 'source-digest.mjs') | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $SourceDigest -cnotmatch '^[a-f0-9]{64}$' -or $Source.sourceDigest -cne $SourceDigest) { throw 'Source changed. Record the exact current source before packaging.' }
$Relay = [Uri]$DefaultRelayUrl
if (-not $Relay.IsAbsoluteUri -or $Relay.Scheme -ne 'https' -or -not $Relay.Host -or $Relay.UserInfo -or $Relay.Query -or $Relay.Fragment) { throw 'An HTTPS default Relay is required.' }
$Spki = [Convert]::FromBase64String($UpdatePublicKeySpki)
if ($Spki.Length -ne 44) { throw 'Ed25519 update public key SPKI is required.' }
$Prefix = [byte[]](0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00)
for ($Index = 0; $Index -lt $Prefix.Length; $Index++) { if ($Spki[$Index] -ne $Prefix[$Index]) { throw 'Update public key must use Ed25519 SPKI.' } }
$PasswordFile = Join-Path $env:LOCALAPPDATA 'AgentPocket\signing\release-password.clixml'
$LegacyProperties = Join-Path $RepoRoot 'android\keystore.properties'
if (-not (Test-Path -LiteralPath $PasswordFile) -or -not (Test-Path -LiteralPath $LegacyProperties)) { throw 'Original signing material is missing; a replacement key will not be generated.' }
if (-not (Test-Path -LiteralPath $ReferenceApk -PathType Leaf)) { throw 'Previously released reference APK is required.' }
$Sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }
if (-not $Sdk -or -not (Test-Path -LiteralPath $Sdk -PathType Container)) { throw 'Set ANDROID_SDK_ROOT to the existing Android SDK directory.' }
$Signer = Join-Path $Sdk 'build-tools\36.0.0\apksigner.bat'
if (-not (Test-Path -LiteralPath $Signer)) { throw 'Android build-tools 36.0.0 are required.' }
function CertificateDigest([string]$Apk) {
    $Result = & $Signer verify --print-certs $Apk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $Line = @($Result | Where-Object { $_ -match '^Signer #[0-9]+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$' })
    if ($Line.Count -ne 1) { throw 'APK certificate cannot be identified.' }
    return ($Line[0] -replace '^.*: ', '').ToLowerInvariant()
}
$ExpectedCertificate = CertificateDigest $ReferenceApk
$ReferenceBadging = & (Join-Path $Sdk 'build-tools\36.0.0\aapt.exe') dump badging $ReferenceApk
if ($LASTEXITCODE -ne 0 -or -not ($ReferenceBadging | Where-Object { $_ -match "^package: name='com.agentpocket.app' " })) { throw 'Reference APK must be the previously released Agent Pocket application.' }
$SecurePassword = Import-Clixml -LiteralPath $PasswordFile
$Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
$OriginalDigest = $env:ORG_GRADLE_PROJECT_agentPocketSourceDigest
$OriginalRelay = $env:ORG_GRADLE_PROJECT_agentPocketDefaultRelayUrl
$OriginalKey = $env:ORG_GRADLE_PROJECT_agentPocketUpdatePublicKeySpki
$OriginalSigningProperties = $env:ORG_GRADLE_PROJECT_agentPocketLegacySigningProperties
try {
    $PlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
    $env:AGENT_POCKET_STORE_PASSWORD = $PlainPassword
    $env:AGENT_POCKET_KEY_PASSWORD = $PlainPassword
    $env:ORG_GRADLE_PROJECT_agentPocketSourceDigest = $SourceDigest
    $env:ORG_GRADLE_PROJECT_agentPocketDefaultRelayUrl = $DefaultRelayUrl
    $env:ORG_GRADLE_PROJECT_agentPocketUpdatePublicKeySpki = $UpdatePublicKeySpki
    $env:ORG_GRADLE_PROJECT_agentPocketLegacySigningProperties = $LegacyProperties
    Push-Location $BuildRoot
    try { & $Flutter build apk --release "--build-name=$VersionName" "--build-number=$VersionCode" --target-platform android-arm,android-arm64,android-x64 `
        "--android-project-arg=agentPocketSourceDigest=$SourceDigest" "--android-project-arg=agentPocketDefaultRelayUrl=$DefaultRelayUrl" `
        "--android-project-arg=agentPocketUpdatePublicKeySpki=$UpdatePublicKeySpki" "--android-project-arg=agentPocketLegacySigningProperties=$LegacyProperties" } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Flutter release build failed.' }
    $CurrentSource = & node (Join-Path $PSScriptRoot 'source-digest.mjs') | ConvertFrom-Json
    if ($CurrentSource.sourceDigest -cne $SourceDigest) { throw 'Source changed during packaging.' }
    $Apk = Join-Path $BuildRoot 'build\app\outputs\flutter-apk\app-release.apk'
    if ((CertificateDigest $Apk) -cne $ExpectedCertificate) { throw 'Original application signature changed.' }
    $Badging = & (Join-Path $Sdk 'build-tools\36.0.0\aapt.exe') dump badging $Apk
    $VersionPattern = [regex]::Escape($VersionName)
    if ($LASTEXITCODE -ne 0 -or -not ($Badging | Where-Object { $_ -match "^package: name='com.agentpocket.app' versionCode='$VersionCode' versionName='$VersionPattern'" }) -or
        -not ($Badging | Where-Object { $_ -ceq "sdkVersion:'26'" })) { throw 'APK identity, version or minimum Android version changed.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [System.IO.Compression.ZipFile]::OpenRead($Apk)
    try {
        $Names = @($Archive.Entries | ForEach-Object FullName)
        foreach ($Abi in @('armeabi-v7a', 'arm64-v8a', 'x86_64')) {
            if (-not ($Names | Where-Object { $_ -match "^lib/$Abi/[^/]*sodium[^/]*\.so$" })) { throw "Missing sodium native library for $Abi" }
            if ($Names -notcontains "lib/$Abi/libapp.so") { throw "Missing Flutter code for $Abi" }
        }
    } finally { $Archive.Dispose() }
    $Seeds = Get-Content -LiteralPath (Join-Path $BuildRoot 'build\app\outputs\mapping\release\seeds.txt')
    foreach ($Registrar in @('com.google.mlkit.common.internal.CommonComponentRegistrar',
        'com.google.mlkit.vision.barcode.internal.BarcodeRegistrar', 'com.google.mlkit.vision.common.internal.VisionCommonRegistrar')) {
        $Constructor = $Registrar + ': ' + $Registrar.Substring($Registrar.LastIndexOf('.') + 1) + '()'
        if ($Seeds -cnotcontains $Constructor) { throw "R8 removed a QR scanner initialization entry point: $Registrar" }
    }
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path $RepoRoot "output\flutter-release-$VersionName" }
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $Destination = Join-Path $OutputDirectory "Agent-Pocket-$VersionName-release.apk"
    Copy-Item -LiteralPath $Apk -Destination $Destination -Force
    $Hash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$Destination.sha256", "$Hash  $([IO.Path]::GetFileName($Destination))`n", [Text.UTF8Encoding]::new($false))
    @{ version=$VersionName; versionCode=$VersionCode; sourceDigest=$SourceDigest; apkSha256=$Hash; certificateSha256=$ExpectedCertificate; reviewStatus='pending'; published=$false } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-record.json') -Encoding UTF8
    Write-Output "APK: $Destination"
} finally {
    Remove-Item Env:AGENT_POCKET_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:AGENT_POCKET_KEY_PASSWORD -ErrorAction SilentlyContinue
    $env:ORG_GRADLE_PROJECT_agentPocketSourceDigest = $OriginalDigest
    $env:ORG_GRADLE_PROJECT_agentPocketDefaultRelayUrl = $OriginalRelay
    $env:ORG_GRADLE_PROJECT_agentPocketUpdatePublicKeySpki = $OriginalKey
    $env:ORG_GRADLE_PROJECT_agentPocketLegacySigningProperties = $OriginalSigningProperties
    $PlainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
}
