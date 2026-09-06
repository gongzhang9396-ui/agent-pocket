param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$RelayUrl,
    [Parameter(Mandatory = $true)][string]$ProjectRoots,
    [string]$AttachmentsPath = "$env:LOCALAPPDATA\AgentPocket\attachments",
    [string]$HostName = $env:COMPUTERNAME,
    [switch]$SkipDesktopAttach
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
if ([string]::IsNullOrWhiteSpace($AttachmentsPath) -or -not [IO.Path]::IsPathRooted($AttachmentsPath)) {
    throw '附件临时目录必须是绝对路径。'
}
$attachmentsPath = [IO.Path]::GetFullPath($AttachmentsPath)
. (Join-Path $PSScriptRoot 'resolve-codex.ps1')
try { $codexCommand = Resolve-CodexCommand }
catch { $codexCommand = 'codex'; Write-Warning 'Codex CLI 尚未安装；Host 仍可使用已登录的 Grok CLI。' }
$stateDir = Join-Path $env:LOCALAPPDATA 'AgentPocket'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path $attachmentsPath | Out-Null
@{
    relayUrl = $uri.AbsoluteUri.TrimEnd('/')
    projectRoots = $roots
    attachmentsPath = $attachmentsPath
    hostName = $HostName
    codexCommand = $codexCommand
    desktopIntegrationEnabled = -not $SkipDesktopAttach
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'host-config.json') -Encoding UTF8

& (Join-Path $InstallDir 'scripts\update-desktop-integration.ps1') -InstallDir $InstallDir

& (Join-Path $InstallDir 'scripts\register-host-tasks.ps1') -InstallDir $InstallDir
. (Join-Path $InstallDir 'scripts\task-names.ps1')
Start-ScheduledTask -TaskName $AgentPocketHostTaskName
