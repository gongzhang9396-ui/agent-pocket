Option Explicit

Dim shell, fso, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "Recover-AgentPocket-Gui.ps1")
command = fso.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe") & " -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & scriptPath & Chr(34)
shell.Run command, 0, False
