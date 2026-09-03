param(
    [string]$Version,
    [string]$SourceCommit = 'HEAD',
    [string]$ReleaseRepository = 'gongzhang9396-ui/agent-pocket-release',
    [string]$RelayUrl = $env:AGENT_POCKET_DEFAULT_RELAY_URL,
    [Parameter(Mandatory = $true)][string]$SigningKeyFile,
    [string]$RelaySshTarget,
    [string]$RelaySshHostFingerprint,
    [string]$RemoteUpdateRoot = '/var/lib/agent-pocket-relay/updates',
    [string]$RemoteRegisterScript = '/usr/local/bin/agent-pocket-register-update',
    [switch]$Publish,
    [switch]$Prerelease
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'VERSION')).Trim()
if (-not $Version) { $Version = $rootVersion }
if ($Version -ne $rootVersion -or $Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must match root VERSION ($rootVersion)." }
if (-not (Test-Path -LiteralPath $SigningKeyFile -PathType Leaf)) { throw 'SigningKeyFile was not found.' }
try { $relayUri = [Uri]$RelayUrl } catch { throw 'RelayUrl must be supplied explicitly as a credential-free HTTPS origin without a trailing slash.' }
if (-not $RelayUrl -or -not $relayUri.IsAbsoluteUri -or $relayUri.Scheme -ne 'https' -or -not $relayUri.Host -or
    $relayUri.UserInfo -or $relayUri.Query -or $relayUri.Fragment -or $relayUri.AbsolutePath -ne '/' -or
    $RelayUrl -ne $RelayUrl.TrimEnd('/')) {
    throw 'RelayUrl must be supplied explicitly as a credential-free HTTPS origin without a trailing slash.'
}
if ($RemoteUpdateRoot -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'RemoteUpdateRoot contains unsafe characters.' }
if ($RemoteRegisterScript -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'RemoteRegisterScript must be an absolute path containing only safe characters.' }
if ($RelaySshTarget -and ($RelaySshTarget -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$' -or -not $RelaySshHostFingerprint)) {
    throw 'Relay SSH publishing requires user@host and RelaySshHostFingerprint.'
}

Push-Location $repoRoot
try {
    $resolvedCommit = (& git rev-parse $SourceCommit).Trim()
    $headCommit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $resolvedCommit) { throw 'SourceCommit does not resolve.' }
    if ($resolvedCommit -ne $headCommit) { throw 'Checkout SourceCommit before publishing; releases are built only from the checked-out commit.' }
    if (@(& git status --porcelain --untracked-files=all).Count -ne 0) { throw 'Commit or remove every working-tree change before building a release.' }
    & node (Join-Path $repoRoot 'scripts\sync-version.mjs') --check
    if ($LASTEXITCODE -ne 0) { throw 'Version files are not synchronized.' }
}
finally { Pop-Location }

$stage = Join-Path $repoRoot "output\private-release-$Version"
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'output')).TrimEnd('\') + '\'
$stage = [IO.Path]::GetFullPath($stage)
if (-not $stage.StartsWith($outputRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release staging path is unsafe.' }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$signer = Join-Path $repoRoot 'installer\windows\scripts\sign-host-update.mjs'
$policyProbe = Join-Path $stage 'update-policy.json'
$policyJson = (& node $signer policy --version $Version --api-url "$RelayUrl/api/updates/host/latest" --output $policyProbe --key-file $SigningKeyFile | Select-Object -Last 1) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $policyJson.publicKeySpki) { throw 'Generating update trust policy failed.' }
$publicKeySpki = [string]$policyJson.publicKeySpki

& (Join-Path $repoRoot 'android\scripts\build-release.ps1') -DefaultRelayUrl $RelayUrl -UpdatePublicKeySpki $publicKeySpki
if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
& (Join-Path $repoRoot 'installer\windows\build-installer.ps1') -AppVersion $Version -DefaultRelayUrl $RelayUrl `
    -UpdateApiUrl "$RelayUrl/api/updates/host/latest" -SigningKeyFile $SigningKeyFile
if ($LASTEXITCODE -ne 0) { throw 'Windows Host release build failed.' }

$apk = Join-Path $repoRoot "android\app\build\outputs\apk\release\Agent-Pocket-$Version-release.apk"
$installer = Join-Path $repoRoot "installer\windows\output\AgentPocketHost-$Version-windows-x64.exe"
$hostPolicy = Join-Path $repoRoot 'installer\windows\output\update-policy.json'
$friendGuide = Join-Path $repoRoot 'docs\FRIEND-QUICKSTART-zh-CN.md'
foreach ($file in @($apk, "$apk.sha256", $installer, "$installer.sha256", "$installer.sig", $hostPolicy)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Release asset is missing: $file" }
    Copy-Item -Force -LiteralPath $file -Destination $stage
}
Copy-Item -Force -LiteralPath $friendGuide -Destination $stage

$stagedApk = Join-Path $stage ([IO.Path]::GetFileName($apk))
$stagedInstaller = Join-Path $stage ([IO.Path]::GetFileName($installer))
$androidVersionCode = (($Version -split '\.')[0..2] | ForEach-Object { [int]$_ })
$androidVersionCode = $androidVersionCode[0] * 10000 + $androidVersionCode[1] * 100 + $androidVersionCode[2]
& node $signer manifest --platform android --version $Version --version-code $androidVersionCode --file $stagedApk `
    --output (Join-Path $stage 'android-manifest.json') --key-file $SigningKeyFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Signing Android update manifest failed.' }
& node $signer manifest --platform host --version $Version --file $stagedInstaller `
    --output (Join-Path $stage 'host-manifest.json') --key-file $SigningKeyFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Signing Host update manifest failed.' }

$releaseMetadata = @{
    version = $Version
    sourceCommit = $resolvedCommit
    relay = $RelayUrl
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $stage 'release-metadata.json'), "$releaseMetadata`n", [Text.UTF8Encoding]::new($false))
$checksumLines = Get-ChildItem -LiteralPath $stage -File | Sort-Object Name | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(), $_.Name
}
[IO.File]::WriteAllLines((Join-Path $stage 'SHA256SUMS.txt'), $checksumLines, [Text.UTF8Encoding]::new($false))
$bundle = Join-Path $stage "Agent-Pocket-$Version-bundle.zip"
$bundleFiles = @(
    $stagedApk,
    "$stagedApk.sha256",
    $stagedInstaller,
    "$stagedInstaller.sha256",
    "$stagedInstaller.sig",
    (Join-Path $stage 'SHA256SUMS.txt'),
    (Join-Path $stage 'FRIEND-QUICKSTART-zh-CN.md')
)
Compress-Archive -LiteralPath $bundleFiles -DestinationPath $bundle
$bundleSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundle).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$bundle.sha256", "$bundleSha256  $([IO.Path]::GetFileName($bundle))`n", [Text.UTF8Encoding]::new($false))

if (-not $Publish) {
    Write-Host "Release staged (dry run): $stage"
    return
}

$repoInfo = (& gh repo view $ReleaseRepository --json visibility,nameWithOwner 2>$null | ConvertFrom-Json)
if (-not $repoInfo -or $repoInfo.visibility -ne 'PRIVATE') { throw "Release repository must exist and be private: $ReleaseRepository" }
$tag = "v$Version"
$assets = @(Get-ChildItem -LiteralPath $stage -File | ForEach-Object FullName)
$releaseArgs = @('release', 'create', $tag, '--repo', $ReleaseRepository, '--title', "Agent Pocket $Version", '--notes', "Private Agent Pocket $Version binaries built from public source commit $resolvedCommit.")
if ($Prerelease) { $releaseArgs += '--prerelease' }
$releaseArgs += $assets
& gh @releaseArgs
if ($LASTEXITCODE -ne 0) { throw 'Uploading the private GitHub Release failed.' }

if ($RelaySshTarget) {
    $hostName = $RelaySshTarget.Split('@', 2)[1]
    $sshDir = Join-Path $stage '.ssh'
    New-Item -ItemType Directory -Path $sshDir | Out-Null
    $knownHosts = Join-Path $sshDir 'known_hosts'
    $scannedHostKeys = @(& ssh-keyscan -t ed25519 $hostName 2>$null)
    if ($LASTEXITCODE -ne 0 -or $scannedHostKeys.Count -eq 0) { throw 'Unable to read Relay SSH host key.' }
    [IO.File]::WriteAllLines($knownHosts, [string[]]$scannedHostKeys, [Text.Encoding]::ASCII)
    $fingerprint = (& ssh-keygen -lf $knownHosts -E sha256 | Select-Object -First 1).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[1]
    if ($fingerprint -ne $RelaySshHostFingerprint) { throw "Relay SSH fingerprint mismatch. Received $fingerprint" }
    $sshOptions = @('-o', "UserKnownHostsFile=$knownHosts", '-o', 'StrictHostKeyChecking=yes')
    foreach ($platform in @('android', 'host')) {
        $assetFile = if ($platform -eq 'android') { $stagedApk } else { $stagedInstaller }
        $manifestFile = Join-Path $stage "$platform-manifest.json"
        $remoteDir = "$RemoteUpdateRoot/$platform/$Version"
        & ssh @sshOptions $RelaySshTarget "mkdir -p '$remoteDir'"
        if ($LASTEXITCODE -ne 0) { throw "Creating remote update directory failed: $platform" }
        & scp @sshOptions $assetFile $manifestFile "$manifestFile.sig" "${RelaySshTarget}:$remoteDir/"
        if ($LASTEXITCODE -ne 0) { throw "Uploading Relay update assets failed: $platform" }
        & ssh @sshOptions $RelaySshTarget "sudo -- '$RemoteRegisterScript' --manifest '$remoteDir/$platform-manifest.json' --signature '$remoteDir/$platform-manifest.json.sig'"
        if ($LASTEXITCODE -ne 0) { throw "Registering Relay update failed: $platform" }
    }
}

Write-Host "Private release published: $ReleaseRepository@$tag"
Write-Host "Source commit: $resolvedCommit"
