# Resolve a native executable: Node spawn(shell:false) cannot execute npm .cmd/.ps1 shims.
# This helper does not execute candidates or read model credentials.
function Resolve-CodexCommand {
    param(
        [string]$ConfiguredCommand,
        [string[]]$PathCandidates = $null,
        [string]$DesktopBin = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')
    )
    if ($null -eq $PathCandidates) {
        $PathCandidates = @(Get-Command codex -All -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandType -in @('Application', 'ExternalScript') } |
            ForEach-Object { $_.Source })
    }
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $target = if ($architecture -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    foreach ($candidate in @($ConfiguredCommand) + @($PathCandidates)) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not [IO.Path]::IsPathRooted($candidate)) { continue }
        if ([IO.Path]::GetExtension($candidate) -eq '.exe' -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
        if ([IO.Path]::GetFileName($candidate) -notin @('codex.cmd', 'codex.ps1')) { continue }
        $modules = Join-Path (Split-Path -Parent $candidate) 'node_modules\@openai'
        $packages = @(
            (Join-Path $modules 'codex'),
            (Join-Path $modules "codex\node_modules\@openai\codex-win32-$architecture"),
            (Join-Path $modules "codex-win32-$architecture")
        )
        foreach ($package in $packages) {
            foreach ($binaryDirectory in @('bin', 'codex')) {
                $native = Join-Path $package "vendor\$target\$binaryDirectory\codex.exe"
                if (Test-Path -LiteralPath $native -PathType Leaf) { return (Resolve-Path -LiteralPath $native).Path }
            }
        }
    }
    if (Test-Path -LiteralPath $DesktopBin -PathType Container) {
        $native = Get-ChildItem -LiteralPath $DesktopBin -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue } |
            Where-Object { -not $_.PSIsContainer } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if ($native) { return $native.FullName }
    }
    throw '找不到可直接运行的 Codex CLI。请安装 Codex CLI 并配置模型 API，或使用 Desktop 附带的 CLI；无需先登录 GPT 账户。'
}
