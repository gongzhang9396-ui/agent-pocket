import { execFile } from 'node:child_process';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
async function windowsAcl(root, protect) {
  const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$path=$env:POCKET_DSH_PRIVATE_ROOT
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
${protect ? `$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($sid)
foreach($identity in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl` : ''}
$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544')
$write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach($rule in (Get-Acl -LiteralPath $path).Access){
  $identity=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -ne 0 -and $identity -notin $allowed){ exit 13 }
}`;
  try { await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, POCKET_DSH_PRIVATE_ROOT: root }, windowsHide: true, timeout: 120000, maxBuffer: 1024 }); }
  catch (cause) { throw new Error('Pocket DSH runtime must be writable only by its user and system administrators', { cause }); }
}
export async function privateRuntime(root, protect = false) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Pocket DSH runtime must be a real directory');
  if (process.platform === 'win32') return windowsAcl(root, protect);
  if (protect) await chmod(root, 0o700);
  const current = await lstat(root);
  if (current.uid !== process.getuid() || (current.mode & 0o022)) throw new Error('Pocket DSH runtime is writable by another user');
}
