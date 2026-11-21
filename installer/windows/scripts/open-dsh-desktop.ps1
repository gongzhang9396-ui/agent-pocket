param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Security','CimCmdlets','NetTCPIP')) {
    Import-Module (Join-Path $PSHOME "Modules/$module/$module.psd1") -ErrorAction Stop
}
$stateDir = Join-Path $env:LOCALAPPDATA 'AgentPocket'
$linkRoot = Join-Path $stateDir 'dsh-desktop'
$installRoot = Split-Path -Parent $PSScriptRoot
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function AssertPrivateFileSystemItem([string]$Path, [bool]$Directory = $false) {
    $item = Get-Item -LiteralPath $Path -Force
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $Directory -or
        ($Directory -and $owner -ne $currentSid) -or $owner -notin @($currentSid,'S-1-5-32-544') -or
        ($Directory -and -not $acl.AreAccessRulesProtected)) { throw 'DeepSeek 共用入口路径或权限无效。' }
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($currentSid,'S-1-5-18')) {
            throw 'DeepSeek 共用入口需要本机私有目录权限。'
        }
    }
    return $item
}
if (-not ('PocketDesktopCommandLine' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PocketDesktopCommandLine {
    [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string command) {
        int count;
        IntPtr memory = CommandLineToArgvW(command, out count);
        if (memory == IntPtr.Zero) throw new InvalidOperationException("Invalid process command line");
        try {
            var result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }
}
'@
}
function TestArguments([string]$Command, [string[]]$Expected) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
    $actual = [PocketDesktopCommandLine]::Parse($Command)
    if ($actual.Count -ne $Expected.Count) { return $false }
    for ($i = 0; $i -lt $actual.Count; $i++) {
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals($actual[$i], $Expected[$i])) { return $false }
    }
    return $true
}
$hostStatus = Get-Content -LiteralPath (Join-Path $stateDir 'host-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]$hostStatus.updatedAt).TotalSeconds
if (-not $hostStatus.running -or $hostStatus.maintenance -or $age -lt -2 -or $age -gt 15 -or [int]$hostStatus.pid -le 0) { throw '请先启动 Agent Pocket Host，再打开 DeepSeek 共用页面。' }
$hostProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$hostStatus.pid)"
$entry = Join-Path $installRoot 'bridge\src\cli.ts'
if (-not $hostProcess -or $hostProcess.Name -ne 'node.exe' -or
    -not (TestArguments $hostProcess.CommandLine @($hostProcess.ExecutablePath,'--experimental-strip-types',$entry,'serve'))) { throw 'Agent Pocket Host 进程未通过核验。' }
$null = AssertPrivateFileSystemItem $linkRoot $true
$marker = AssertPrivateFileSystemItem (Join-Path $linkRoot '.agent-pocket-dsh-desktop-v1')
if ($marker.Length -ne [Text.Encoding]::UTF8.GetByteCount("agent-pocket-dsh-desktop-v1`n") -or
    (Get-Content -LiteralPath $marker.FullName -Raw -Encoding UTF8) -cne "agent-pocket-dsh-desktop-v1`n") { throw 'DeepSeek 共用入口尚未准备好。' }
$candidates = @()
foreach ($file in @(Get-ChildItem -LiteralPath $linkRoot -Filter "host-$($hostStatus.pid)-runtime-*.json" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 16)) {
    $null = AssertPrivateFileSystemItem $file.FullName
    if ($file.Length -gt 8192) { continue }
    $link = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($link.version -ne 1 -or $link.hostPid -ne $hostStatus.pid -or [int]$link.runtimePid -le 0 -or
        $link.nonce -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
        $file.Name -cne "host-$($link.hostPid)-runtime-$($link.runtimePid)-$($link.nonce).json") { continue }
    foreach ($path in @($link.nodeExecutable,$link.runtimeRoot,$link.home)) {
        if (-not [IO.Path]::IsPathRooted([string]$path) -or [string]$path -match '[\r\n\x00]') { throw 'DeepSeek 共用入口进程路径无效。' }
    }
    $runtime = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$link.runtimePid)"
    if (-not $runtime -or $runtime.Name -ne 'node.exe' -or $runtime.ParentProcessId -ne $hostStatus.pid -or
        $runtime.ExecutablePath -ne $hostProcess.ExecutablePath -or $link.nodeExecutable -ne $hostProcess.ExecutablePath) { continue }
    $expected = @($link.nodeExecutable,(Join-Path $link.runtimeRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'),
        '--profile','agent-pocket','--patch',(Join-Path $link.home 'profiles\agent-pocket\pocket-launch.patch.json'),
        '--no-open','--host','127.0.0.1','--port','0')
    if (-not (TestArguments $runtime.CommandLine $expected)) { continue }
    $hostTime = [DateTimeOffset]::new($hostProcess.CreationDate).ToUnixTimeMilliseconds()
    $runtimeTime = [DateTimeOffset]::new($runtime.CreationDate).ToUnixTimeMilliseconds()
    $times = @([double]$link.hostStartedAt, [double]$link.runtimeStartedAt)
    if (@($times | Where-Object { [double]::IsNaN($_) -or [double]::IsInfinity($_) -or $_ -le 0 }).Count -or
        [Math]::Abs($hostTime - $times[0]) -gt 5000 -or [Math]::Abs($runtimeTime - $times[1]) -gt 5000) { continue }
    $url = [Uri]$link.url
    if (-not $url.IsAbsoluteUri -or $url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.Port -le 0 -or $url.UserInfo -or $url.AbsolutePath -ne '/' -or $url.Fragment -or $url.Query -cnotmatch '^\?token=[A-Za-z0-9_-]{43}$') { throw 'DeepSeek 共用页面地址无效。' }
    $listener = @(Get-NetTCPConnection -OwningProcess $runtime.ProcessId -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq $url.Port })
    if ($listener.Count -eq 1) { $candidates += @{url=$url;runtimePid=$runtime.ProcessId} }
}
if ($candidates.Count -ne 1) { throw 'DeepSeek 共用服务正在准备，请稍后再打开。' }
if ($ValidateOnly) { @{hostPid=$hostProcess.ProcessId;runtimePid=$candidates[0].runtimePid;port=$candidates[0].url.Port;validated=$true} | ConvertTo-Json -Compress }
else { Start-Process -FilePath $candidates[0].url.AbsoluteUri | Out-Null }
