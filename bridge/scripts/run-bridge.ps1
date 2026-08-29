$ErrorActionPreference = "Stop"
$BridgeRoot = Split-Path -Parent $PSScriptRoot
$ProcessUtils = Join-Path $PSScriptRoot "process-utils.ps1"
. $ProcessUtils
$ConfigFile = Join-Path $BridgeRoot "bridge.env.ps1"
if (Test-Path -LiteralPath $ConfigFile) { . $ConfigFile }

$LogRoot = Join-Path $env:LOCALAPPDATA "AgentPocket"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$Account = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $LogRoot /inheritance:r /grant:r "$Account`:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
$InstallFile = Join-Path $LogRoot "installed.json"
if (-not (Test-Path -LiteralPath $InstallFile)) { throw "Missing install state. Run install-task.ps1 again." }
$Install = Get-Content -Raw -Encoding UTF8 -LiteralPath $InstallFile | ConvertFrom-Json
$Node = [string]$Install.node
$Codex = [string]$Install.codex
if (-not (Test-Path -LiteralPath $Node)) { throw "Node.exe from installed.json is missing." }
if (-not (Test-Path -LiteralPath $Codex)) { throw "codex.exe from installed.json is missing." }
if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$Install.bridgeRoot), [System.IO.Path]::GetFullPath($BridgeRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Scheduled task path does not match installed bridge root. Run install-task.ps1 again."
}

$env:AGENT_POCKET_CODEX = $Codex
$CodexDir = Split-Path -Parent $Codex
if ($CodexDir) { $env:PATH = $CodexDir + ";" + $env:PATH }
$LogFile = Join-Path $LogRoot "bridge.log"
$ErrorLog = Join-Path $LogRoot "bridge-error.log"
$PidFile = Join-Path $LogRoot "bridge.pid"
$Cli = Join-Path $BridgeRoot "src\cli.ts"
Set-Location -LiteralPath $BridgeRoot
Stop-AgentPocketInstalledBridge -Install $Install -PidFile $PidFile -FailOnForeignListener

# Windows PowerShell 5 cannot combine Start-Process -WindowStyle with redirected streams.
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Stamp = "[" + [DateTimeOffset]::Now.ToString("o") + "] starting bridge`r`n"
$Psi = New-Object System.Diagnostics.ProcessStartInfo
$Psi.FileName = $Node
$Psi.Arguments = "--experimental-strip-types `"$Cli`" serve"
$Psi.WorkingDirectory = $BridgeRoot
$Psi.UseShellExecute = $false
$Psi.RedirectStandardOutput = $true
$Psi.RedirectStandardError = $true
$Psi.CreateNoWindow = $true
$Psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$Psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$Psi.EnvironmentVariables["AGENT_POCKET_CODEX"] = $Codex
$Psi.EnvironmentVariables["PATH"] = $env:PATH

if (-not ([System.Management.Automation.PSTypeName]"AgentPocketLogCopy").Type) {
    Add-Type -TypeDefinition @"
using System.IO;
using System.Text;
using System.Threading;
public static class AgentPocketLogCopy {
  public static Thread Start(StreamReader reader, FileStream destination, Encoding encoding) {
    Thread thread = new Thread(delegate() {
      try {
        string line;
        while ((line = reader.ReadLine()) != null) {
          byte[] bytes = encoding.GetBytes(line + "\r\n");
          destination.Write(bytes, 0, bytes.Length);
          destination.Flush();
        }
      } catch {}
    });
    thread.IsBackground = true;
    thread.Start();
    return thread;
  }
}
"@
}

$Process = New-Object System.Diagnostics.Process
$Process.StartInfo = $Psi
$OutStream = $null
$ErrorStream = $null
$OutThread = $null
$ErrorThread = $null
$Started = $false
$ExitCode = 1
try {
    $OutStream = New-Object System.IO.FileStream($LogFile, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read, 4096, [System.IO.FileOptions]::WriteThrough)
    $ErrorStream = New-Object System.IO.FileStream($ErrorLog, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read, 4096, [System.IO.FileOptions]::WriteThrough)
    if (-not $Process.Start()) { throw "Failed to start Node." }
    $Started = $true
    [System.IO.File]::WriteAllText($PidFile, [string]$Process.Id, $Utf8)
    $bytes = $Utf8.GetBytes($Stamp)
    $OutStream.Write($bytes, 0, $bytes.Length)
    $OutStream.Flush()
    $OutThread = [AgentPocketLogCopy]::Start($Process.StandardOutput, $OutStream, $Utf8)
    $ErrorThread = [AgentPocketLogCopy]::Start($Process.StandardError, $ErrorStream, $Utf8)
    $Process.WaitForExit()
    if ($OutThread) { [void]$OutThread.Join(2000) }
    if ($ErrorThread) { [void]$ErrorThread.Join(2000) }
    $ExitCode = $Process.ExitCode
}
finally {
    if ($Started -and -not $Process.HasExited) {
        try { $Process.Kill() } catch {}
    }
    if ($OutStream) { $OutStream.Dispose() }
    if ($ErrorStream) { $ErrorStream.Dispose() }
    if ($Process) { $Process.Dispose() }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
exit $ExitCode
