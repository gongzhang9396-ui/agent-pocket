$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\resolve-codex.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('agent-pocket-runtime-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$checks = 0
function Assert-Equal($Expected, $Actual, [string]$Label) {
    if ($Expected -ne $Actual) { throw "$Label failed: expected $Expected, got $Actual" }
    $script:checks++
}
function New-FixtureFile([string]$RelativePath) {
    $path = Join-Path $testRoot $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    [IO.File]::WriteAllText($path, 'fixture; never executed')
    return $path
}
try {
    $absentDesktop = Join-Path $testRoot 'no-desktop'
    $native = New-FixtureFile 'native\codex.exe'
    Assert-Equal $native (Resolve-CodexCommand -ConfiguredCommand $native -PathCandidates @() -DesktopBin $absentDesktop) 'Native CLI'
    Assert-Equal $native (Resolve-CodexCommand -ConfiguredCommand (Join-Path $testRoot 'removed.exe') -PathCandidates @($native) -DesktopBin $absentDesktop) 'Moved CLI'
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $target = if ($architecture -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    $layouts = @('codex', "codex\node_modules\@openai\codex-win32-$architecture", "codex-win32-$architecture")
    for ($index = 0; $index -lt $layouts.Count; $index++) {
        foreach ($binaryDirectory in @('bin', 'codex')) {
            $shim = New-FixtureFile "npm-$index-$binaryDirectory\codex.ps1"
            $binary = New-FixtureFile "npm-$index-$binaryDirectory\node_modules\@openai\$($layouts[$index])\vendor\$target\$binaryDirectory\codex.exe"
            Assert-Equal $binary (Resolve-CodexCommand -PathCandidates @($shim) -DesktopBin $absentDesktop) "Npm layout $index/$binaryDirectory"
        }
    }
    $desktop = New-FixtureFile 'desktop\current-version\codex.exe'
    Assert-Equal $desktop (Resolve-CodexCommand -PathCandidates @() -DesktopBin (Join-Path $testRoot 'desktop')) 'Desktop bundled CLI'
    $bareShim = New-FixtureFile 'bare\codex.cmd'
    $failed = $false
    try { [void](Resolve-CodexCommand -PathCandidates @($bareShim) -DesktopBin $absentDesktop) } catch { $failed = $true }
    Assert-Equal $true $failed 'Unresolved shim is rejected'

    # Isolate the optional integration script from real configuration and plugins.
    $previousLocalAppData = $env:LOCALAPPDATA
    try {
        $env:LOCALAPPDATA = Join-Path $testRoot 'profile'
        $stateDir = Join-Path $env:LOCALAPPDATA 'AgentPocket'
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
        $stubInstall = Join-Path $testRoot 'install'
        New-Item -ItemType Directory -Force -Path (Join-Path $stubInstall 'scripts') | Out-Null
        [IO.File]::WriteAllText((Join-Path $stubInstall 'scripts\install-desktop-plugin.ps1'), 'throw "No Desktop installed"')
        @{ desktopIntegrationEnabled = $true } | ConvertTo-Json | Set-Content (Join-Path $stateDir 'host-config.json') -Encoding UTF8
        & (Join-Path $PSScriptRoot 'scripts\update-desktop-integration.ps1') -InstallDir $stubInstall
        $status = Get-Content -Raw (Join-Path $stateDir 'desktop-integration-status.json') | ConvertFrom-Json
        Assert-Equal 'unavailable' $status.state 'API Host survives missing Desktop'
        @{ desktopIntegrationEnabled = $false } | ConvertTo-Json | Set-Content (Join-Path $stateDir 'host-config.json') -Encoding UTF8
        & (Join-Path $PSScriptRoot 'scripts\update-desktop-integration.ps1') -InstallDir $stubInstall
        $status = Get-Content -Raw (Join-Path $stateDir 'desktop-integration-status.json') | ConvertFrom-Json
        Assert-Equal 'disabled' $status.state 'Explicit opt-out is preserved'
    } finally { $env:LOCALAPPDATA = $previousLocalAppData }
    Write-Output "$checks runtime checks passed; no real installation or account changed."
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'agent-pocket-runtime-*') { throw 'Fixture cleanup escaped test root' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
