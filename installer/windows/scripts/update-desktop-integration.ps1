param([Parameter(Mandatory = $true)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'AgentPocket'
$configPath = Join-Path $stateDir 'host-config.json'
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$state = 'disabled'
if ($config.desktopIntegrationEnabled -ne $false) {
    try {
        & (Join-Path $InstallDir 'scripts\install-desktop-plugin.ps1') -InstallDir $InstallDir
        $state = 'ready'
    } catch {
        $state = 'unavailable'
        Write-Warning 'Desktop Attach 暂不可用；Host API 任务仍可使用。安装 Desktop 后可重新运行 install-desktop-plugin.ps1。'
    }
}
@{ state = $state; checkedAt = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'desktop-integration-status.json') -Encoding UTF8
