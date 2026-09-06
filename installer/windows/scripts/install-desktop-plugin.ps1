param(
    [Parameter(Mandatory = $true)][string]$InstallDir
)

$ErrorActionPreference = 'Stop'

function Normalize-LocalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $candidate = $Path
    if ($candidate.StartsWith('\\?\')) { $candidate = $candidate.Substring(4) }
    return [IO.Path]::GetFullPath($candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Invoke-CodexJson([string[]]$Arguments, [string]$FailureMessage) {
    $output = @(& $script:CodexPath @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage：$($output -join [Environment]::NewLine)"
    }
    try {
        return (($output | Out-String) | ConvertFrom-Json)
    }
    catch {
        throw "$FailureMessage：Codex CLI 返回了无法识别的结果。"
    }
}

. (Join-Path $PSScriptRoot 'resolve-codex.ps1')
$configPath = Join-Path $env:LOCALAPPDATA 'AgentPocket\host-config.json'
$configuredCommand = if (Test-Path -LiteralPath $configPath) { (Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json).codexCommand } else { $null }
$script:CodexPath = Resolve-CodexCommand $configuredCommand

$marketplacePath = Normalize-LocalPath (Join-Path $InstallDir 'marketplace')
if (-not (Test-Path -LiteralPath (Join-Path $marketplacePath '.agents\plugins\marketplace.json') -PathType Leaf)) {
    throw "Agent Pocket Codex Marketplace 不完整：$marketplacePath"
}

$marketplaces = Invoke-CodexJson -Arguments @('plugin', 'marketplace', 'list', '--json') -FailureMessage '读取 Codex Marketplace 失败'
$marketplace = @($marketplaces.marketplaces) | Where-Object {
    (Normalize-LocalPath $_.root) -eq $marketplacePath
} | Select-Object -First 1

if ($marketplace) {
    $marketplaceName = $marketplace.name
}
else {
    $added = Invoke-CodexJson -Arguments @('plugin', 'marketplace', 'add', $marketplacePath, '--json') -FailureMessage '注册本地 Codex Marketplace 失败'
    $marketplaceName = $added.marketplaceName
}
if ([string]::IsNullOrWhiteSpace($marketplaceName)) { throw 'Codex CLI 没有返回 Marketplace 名称。' }

$pluginSelector = "agent-pocket-desktop-attach@$marketplaceName"
$pluginSourcePath = Normalize-LocalPath (Join-Path $marketplacePath 'plugins\agent-pocket-desktop-attach')
$pluginManifestPath = Join-Path $pluginSourcePath '.codex-plugin\plugin.json'
try {
    $desiredVersion = (Get-Content -LiteralPath $pluginManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
catch {
    throw "Desktop Attach 插件清单无效：$pluginManifestPath"
}
if ([string]::IsNullOrWhiteSpace($desiredVersion)) { throw 'Desktop Attach 插件清单缺少版本号。' }

$plugins = Invoke-CodexJson -Arguments @('plugin', 'list', '--json') -FailureMessage '读取 Codex 插件列表失败'
$installed = @($plugins.installed) | Where-Object { $_.pluginId -eq $pluginSelector } | Select-Object -First 1
$installedSourcePath = if ($installed) { Normalize-LocalPath ([string]$installed.source.path) } else { '' }
if ($installed -and $installed.version -eq $desiredVersion -and $installedSourcePath -eq $pluginSourcePath) { return }

[void](Invoke-CodexJson -Arguments @('plugin', 'add', $pluginSelector, '--json') -FailureMessage '安装 Desktop Attach 插件失败')
