param(
    [string]$AppVersion,
    [string]$NodeVersion = '24.12.0',
    [string]$UpdateApiUrl = 'https://api.github.com/repos/gongzhang9396-ui/agent-pocket/releases/latest',
    [string]$DefaultRelayUrl = $env:AGENT_POCKET_DEFAULT_RELAY_URL,
    [string]$SigningKeyFile = $env:AGENT_POCKET_HOST_UPDATE_SIGNING_KEY_FILE,
    [string]$InnoCompiler = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$rootVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'VERSION')).Trim()
if (-not $AppVersion) { $AppVersion = $rootVersion }
if ($AppVersion -notmatch '^\d+\.\d+\.\d+$' -or $AppVersion -ne $rootVersion) {
    throw "AppVersion must match root VERSION ($rootVersion)."
}
$updateUri = [Uri]$UpdateApiUrl
if ($updateUri.Scheme -ne 'https' -or -not $updateUri.Host -or $updateUri.UserInfo -or $updateUri.Fragment) {
    throw 'UpdateApiUrl must be a credential-free HTTPS URL.'
}
if ([string]::IsNullOrWhiteSpace($DefaultRelayUrl)) { $DefaultRelayUrl = 'https://relay.example.com' }
$DefaultRelayUrl = $DefaultRelayUrl.Trim().TrimEnd('/')
try { $defaultRelayUri = [Uri]$DefaultRelayUrl } catch { throw 'DefaultRelayUrl must be a valid HTTPS URL.' }
if (-not $defaultRelayUri.IsAbsoluteUri -or $defaultRelayUri.Scheme -ne 'https' -or
    -not $defaultRelayUri.Host -or $defaultRelayUri.UserInfo -or $defaultRelayUri.Query -or
    $defaultRelayUri.Fragment -or $DefaultRelayUrl.Contains("'") -or $DefaultRelayUrl.Contains('"')) {
    throw 'DefaultRelayUrl must be a credential-free HTTPS URL without query, fragment, or quote characters.'
}
if (-not $SigningKeyFile -and -not $env:AGENT_POCKET_HOST_UPDATE_SIGNING_KEY) {
    throw 'Set AGENT_POCKET_HOST_UPDATE_SIGNING_KEY, AGENT_POCKET_HOST_UPDATE_SIGNING_KEY_FILE, or -SigningKeyFile.'
}
if ($SigningKeyFile -and -not (Test-Path -LiteralPath $SigningKeyFile -PathType Leaf)) {
    throw "Host update signing key was not found: $SigningKeyFile"
}
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$payload = [IO.Path]::GetFullPath((Join-Path $scriptRoot 'payload'))
if (-not $payload.StartsWith($scriptRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid payload path.' }
if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload -Recurse -Force }
New-Item -ItemType Directory -Path $payload | Out-Null

function Copy-AllowlistedFiles([string]$SourceRoot, [string]$DestinationRoot, [string[]]$RelativePaths) {
    $sourcePrefix = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') + '\'
    $destinationPrefix = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\') + '\'
    foreach ($relativePath in $RelativePaths) {
        if ([IO.Path]::IsPathRooted($relativePath)) { throw "Allowlisted payload path must be relative: $relativePath" }
        $source = [IO.Path]::GetFullPath((Join-Path $SourceRoot $relativePath))
        $destination = [IO.Path]::GetFullPath((Join-Path $DestinationRoot $relativePath))
        if (-not $source.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not $destination.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Allowlisted payload path escapes its staging root: $relativePath"
        }
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Allowlisted payload file is missing: $source" }
        New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Copy-Item -Force -LiteralPath $source -Destination $destination
    }
    $actual = @(Get-ChildItem -LiteralPath $DestinationRoot -Recurse -File | ForEach-Object {
        $_.FullName.Substring($destinationPrefix.Length).Replace('\', '/')
    } | Sort-Object)
    $expected = @($RelativePaths | ForEach-Object { $_.Replace('\', '/') } | Sort-Object)
    if (Compare-Object -ReferenceObject $expected -DifferenceObject $actual) {
        throw "Payload staging contains files outside the explicit allowlist: $DestinationRoot"
    }
}

$cache = Join-Path $scriptRoot '.cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$archiveName = "node-v$NodeVersion-win-x64.zip"
$archive = Join-Path $cache $archiveName
$checksums = Join-Path $cache "SHASUMS256-$NodeVersion.txt"
$base = "https://nodejs.org/dist/v$NodeVersion"
try {
    Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt" -OutFile $checksums
}
catch {
    # Some managed Windows networks terminate the legacy PowerShell HTTP stack
    # mid-TLS while the system curl client remains usable. Keep the same HTTPS
    # source and fail closed if neither client can download the checksum list.
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $curl) { throw }
    & $curl.Source --fail --location --silent --show-error --retry 3 --output $checksums "$base/SHASUMS256.txt"
    if ($LASTEXITCODE -ne 0) { throw "Downloading the Node.js checksum manifest failed with curl exit code $LASTEXITCODE." }
}
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -UseBasicParsing "$base/$archiveName" -OutFile $archive }
$expected = (Get-Content -LiteralPath $checksums | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1).Split(' ')[0]
if (-not $expected) { throw 'Node.js checksum is missing from the official manifest.' }
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
if ($actual -ne $expected.ToUpperInvariant()) { throw 'Node.js runtime SHA-256 mismatch.' }

$nodeTemp = Join-Path $cache "node-v$NodeVersion-win-x64"
if (Test-Path -LiteralPath $nodeTemp) { Remove-Item -LiteralPath $nodeTemp -Recurse -Force }
Expand-Archive -LiteralPath $archive -DestinationPath $cache
Copy-Item -LiteralPath $nodeTemp -Destination (Join-Path $payload 'node') -Recurse
$bundledNode = Join-Path $payload 'node\node.exe'
$signer = Join-Path $scriptRoot 'scripts\sign-host-update.mjs'
$policyArgs = @($signer, 'policy', '--version', $AppVersion, '--api-url', $UpdateApiUrl, '--output', (Join-Path $payload 'update-policy.json'))
if ($SigningKeyFile) { $policyArgs += @('--key-file', $SigningKeyFile) }
& $bundledNode @policyArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Generating the Host update policy failed.' }

$bridgeStage = Join-Path $payload 'bridge'
New-Item -ItemType Directory -Path $bridgeStage | Out-Null
$bridgeFiles = @(
    'package.json',
    'package-lock.json',
    'src\cli.ts',
    'src\codex.ts',
    'src\config.ts',
    'src\desktop-attach.ts',
    'src\fcm.ts',
    'src\host-updater.ts',
    'src\protocol.ts',
    'src\relay-connector.ts',
    'src\relay-crypto.ts',
    'src\server.ts',
    'src\store.ts'
)
Copy-AllowlistedFiles (Join-Path $repoRoot 'bridge') $bridgeStage $bridgeFiles
Push-Location $bridgeStage
try { & (Join-Path $payload 'node\npm.cmd') ci --omit=dev --ignore-scripts } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Installing Bridge production dependencies failed.' }

$marketplace = Join-Path $payload 'marketplace'
New-Item -ItemType Directory -Force -Path (Join-Path $marketplace '.agents\plugins') | Out-Null
Copy-Item -LiteralPath (Join-Path $scriptRoot 'marketplace\.agents\plugins\marketplace.json') -Destination (Join-Path $marketplace '.agents\plugins\marketplace.json')
$pluginStage = Join-Path $marketplace 'plugins\agent-pocket-desktop-attach'
New-Item -ItemType Directory -Force -Path $pluginStage | Out-Null
Copy-AllowlistedFiles (Join-Path $repoRoot 'desktop-attach-plugin') $pluginStage @(
    '.codex-plugin\plugin.json',
    '.mcp.json',
    'hooks\hooks.json',
    'server.mjs'
)
$scriptsStage = Join-Path $payload 'scripts'
New-Item -ItemType Directory -Force -Path $scriptsStage | Out-Null
Copy-AllowlistedFiles (Join-Path $scriptRoot 'scripts') $scriptsStage @(
    'check-host-update.ps1',
    'configure-host.ps1',
    'enroll-host.ps1',
    'install-desktop-plugin.ps1',
    'pairing-assistant.ps1',
    'register-host-tasks.ps1',
    'run-host.ps1',
    'task-names.ps1',
    'uninstall-host.ps1'
)
$utf8Bom = [Text.UTF8Encoding]::new($true)
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($script in Get-ChildItem -LiteralPath $scriptsStage -Filter '*.ps1' -File) {
    $text = [IO.File]::ReadAllText($script.FullName, $strictUtf8)
    [IO.File]::WriteAllText($script.FullName, $text, $utf8Bom)
    $env:AGENT_POCKET_SCRIPT_PARSE_TARGET = $script.FullName
    try {
        & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -Command '$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile($env:AGENT_POCKET_SCRIPT_PARSE_TARGET, [ref]$tokens, [ref]$errors) > $null; if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_) }; exit 1 }'
        if ($LASTEXITCODE -ne 0) { throw "Windows PowerShell 5.1 cannot parse payload script: $($script.Name)" }
    } finally {
        Remove-Item Env:AGENT_POCKET_SCRIPT_PARSE_TARGET -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
    $innoInstall = Get-ItemProperty `
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', `
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', `
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Inno Setup*' -and $_.InstallLocation } |
        Select-Object -First 1
    if ($innoInstall) { $InnoCompiler = Join-Path ([string]$innoInstall.InstallLocation) 'ISCC.exe' }
}
if (-not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) { throw "Inno Setup compiler not found: $InnoCompiler" }
& $InnoCompiler "/DMyAppVersion=$AppVersion" "/DMyDefaultRelayUrl=$DefaultRelayUrl" (Join-Path $scriptRoot 'AgentPocketHost.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
$installerPath = Join-Path $scriptRoot "output\AgentPocketHost-$AppVersion-windows-x64.exe"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw 'Inno Setup did not produce the expected installer.' }
$signArgs = @($signer, 'sign', '--version', $AppVersion, '--file', $installerPath)
if ($SigningKeyFile) { $signArgs += @('--key-file', $SigningKeyFile) }
$signed = (& $bundledNode @signArgs | Select-Object -Last 1) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Signing the Host installer failed.' }
Copy-Item -Force -LiteralPath (Join-Path $payload 'update-policy.json') -Destination (Join-Path $scriptRoot 'output\update-policy.json')
$installer = Get-Item -LiteralPath $installerPath
$hash = [string]$signed.sha256
Write-Host "Installer: $($installer.FullName)"
Write-Host "SHA-256: $hash"
Write-Host "Signature: $($installer.FullName).sig"
Write-Host "Update policy: $(Join-Path $scriptRoot 'output\update-policy.json')"
