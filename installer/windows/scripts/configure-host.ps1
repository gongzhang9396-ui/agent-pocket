param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$RelayUrl,
    [Parameter(Mandatory = $true)][string]$ProjectRoots,
    [string]$HostName = $env:COMPUTERNAME
)
$ErrorActionPreference = 'Stop'
$uri = [Uri]$RelayUrl
if ($uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo -or $uri.Fragment) {
    throw 'Relay 地址必须是无用户名、密码和片段的完整 https:// URL。'
}
$roots = @($ProjectRoots -split [IO.Path]::PathSeparator | Where-Object { $_ } | ForEach-Object {
    $resolved = [IO.Path]::GetFullPath($_)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw "项目根目录不存在：$resolved" }
    $resolved
})
if ($roots.Count -eq 0) { throw '至少需要一个项目根目录。' }
$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) { throw '没有找到 Codex CLI。请先安装并登录 Codex Desktop。' }
$stateDir = Join-Path $env:LOCALAPPDATA 'AgentPocket'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
    relayUrl = $uri.AbsoluteUri.TrimEnd('/')
    projectRoots = $roots
    hostName = $HostName
    codexCommand = $codex.Source
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'host-config.json') -Encoding UTF8

$marketplace = Join-Path $InstallDir 'marketplace'
$marketplaceResult = & $codex.Source plugin marketplace add $marketplace --json 2>&1
if ($LASTEXITCODE -ne 0) { throw "注册本地 Codex Marketplace 失败：$marketplaceResult" }
$marketplaceName = (($marketplaceResult | Out-String) | ConvertFrom-Json).marketplaceName
if (-not $marketplaceName) { $marketplaceName = 'agent-pocket-host' }
$pluginResult = & $codex.Source plugin add "agent-pocket-desktop-attach@$marketplaceName" --json 2>&1
if ($LASTEXITCODE -ne 0) { throw "安装 Desktop Attach 插件失败：$pluginResult" }

& (Join-Path $InstallDir 'scripts\register-host-tasks.ps1') -InstallDir $InstallDir
if ($LASTEXITCODE -ne 0) { throw '注册 Agent Pocket Host 计划任务失败。' }
. (Join-Path $InstallDir 'scripts\task-names.ps1')
Start-ScheduledTask -TaskName $AgentPocketHostTaskName
