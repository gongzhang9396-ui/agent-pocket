$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'resolve-codex.ps1')

$configPath = Join-Path $env:LOCALAPPDATA 'AgentPocket\host-config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'Agent Pocket Host 尚未配置。请从开始菜单运行“配置 Agent Pocket Host”。'
}
$stateDir = Split-Path -Parent $configPath
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$roots = @($config.projectRoots | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })
if ($roots.Count -eq 0) { throw '项目白名单不能为空。' }
$attachmentsPath = [string]$config.attachmentsPath
if ([string]::IsNullOrWhiteSpace($attachmentsPath)) {
    $attachmentsPath = Join-Path $stateDir 'attachments'
}
if (-not [IO.Path]::IsPathRooted($attachmentsPath)) { throw '附件临时目录必须是绝对路径。' }
$attachmentsPath = [IO.Path]::GetFullPath($attachmentsPath)
New-Item -ItemType Directory -Force -Path $attachmentsPath | Out-Null
try { $codexCommand = Resolve-CodexCommand ([string]$config.codexCommand) }
catch { $codexCommand = 'codex'; Write-Warning 'Codex CLI 尚未就绪；Host 将继续提供其他 Agent。' }
if (-not [string]::IsNullOrWhiteSpace([string]$config.grokCommand)) { $env:AGENT_POCKET_GROK = [string]$config.grokCommand }
$env:AGENT_POCKET_PORT = '0'
$env:AGENT_POCKET_DB = Join-Path $stateDir 'bridge-v2.db'
$env:AGENT_POCKET_ATTACHMENTS_DIR = $attachmentsPath
$env:AGENT_POCKET_CODEX = $codexCommand
$env:AGENT_POCKET_PROJECT_ROOTS = $roots -join [IO.Path]::PathSeparator
$env:AGENT_POCKET_RELAY_URL = [string]$config.relayUrl
$env:AGENT_POCKET_HOST_NAME = [string]$config.hostName
$env:AGENT_POCKET_RELAY_IDENTITY = Join-Path $env:LOCALAPPDATA 'AgentPocket\relay-host.json'
$node = Join-Path $installDir 'node\node.exe'
$entry = Join-Path $installDir 'bridge\src\cli.ts'
$outputLog = Join-Path $stateDir 'host-v2.log'
$errorLog = Join-Path $stateDir 'host-v2-error.log'
foreach ($log in @($outputLog, $errorLog)) {
    if ((Test-Path -LiteralPath $log -PathType Leaf) -and (Get-Item -LiteralPath $log).Length -gt 2MB) {
        Move-Item -LiteralPath $log -Destination "$log.previous" -Force
    }
}
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $node --experimental-strip-types $entry serve 1>> $outputLog 2>> $errorLog
$nodeExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
exit $nodeExitCode
