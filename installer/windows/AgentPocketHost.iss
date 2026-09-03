#define MyAppName "Agent Pocket Host"
#ifndef MyAppVersion
#define MyAppVersion "0.3.2"
#endif
#ifndef MyDefaultRelayUrl
#define MyDefaultRelayUrl "https://relay.example.com"
#endif
#define MyAppPublisher "Agent Pocket Contributors"

[Setup]
AppId={{5B7113C5-B584-45A2-8478-E24C17E63D26}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
UninstallDisplayName={#MyAppName}
DefaultDirName={localappdata}\Programs\Agent Pocket Host
DefaultGroupName=Agent Pocket
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=AgentPocketHost-{#MyAppVersion}-windows-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
UninstallDisplayIcon={app}\node\node.exe
VersionInfoVersion={#MyAppVersion}

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Agent Pocket 配对助手"; Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\pairing-assistant.ps1"""
Name: "{group}\检查 Agent Pocket Host 更新"; Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\check-host-update.ps1"" -InstallDir ""{app}"" -Interactive"
Name: "{group}\卸载 Agent Pocket Host"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\pairing-assistant.ps1"""; Description: "打开 Agent Pocket 配对助手"; Flags: postinstall skipifsilent nowait; Check: IsFirstInstall

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall-host.ps1"" -InstallDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "AgentPocketHostUninstallKeep"; Check: ShouldKeepLocalAccountOnUninstall
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall-host.ps1"" -InstallDir ""{app}"" -RemoveUserData"; Flags: runhidden waituntilterminated; RunOnceId: "AgentPocketHostUninstallRemove"; Check: ShouldRemoveLocalAccountOnUninstall

[UninstallDelete]
Type: filesandordirs; Name: "{app}\marketplace"

[Code]
var
  RelayPage: TInputQueryWizardPage;
  RootsPage: TInputQueryWizardPage;
  AttachmentsPage: TInputQueryWizardPage;
  ExistingConfig: Boolean;
  HostStoppedForUpgrade: Boolean;
  InstallCompleted: Boolean;
  RemoveLocalAccountOnUninstall: Boolean;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  RemoveLocalAccountOnUninstall := False;
  if UninstallSilent then
    exit;

  RemoveLocalAccountOnUninstall :=
    MsgBox(
      '是否同时删除这台电脑上的本地账号与绑定数据？' + #13#10 + #13#10 +
      '选择“否”（推荐）：只卸载程序，保留本机绑定、任务数据库和默认附件，重装后可继续使用。' + #13#10 + #13#10 +
      '选择“是”：删除 %LOCALAPPDATA%\AgentPocket 中的本地身份、配置、数据库、日志和默认附件。Relay 云端账号、手机和其他电脑不会被删除；外置附件目录需自行处理。',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

function ShouldKeepLocalAccountOnUninstall(): Boolean;
begin
  Result := not RemoveLocalAccountOnUninstall;
end;

function ShouldRemoveLocalAccountOnUninstall(): Boolean;
begin
  Result := RemoveLocalAccountOnUninstall;
end;

function StopExistingHostTasks: Boolean;
var
  ResultCode: Integer;
  Params: String;
begin
  Params := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $names = @((''Agent Pocket Host v2 '' + $sid), (''Agent Pocket Host Update '' + $sid), ''Agent Pocket Host v2''); $tasks = @($names | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }); $tasks | Stop-ScheduledTask -ErrorAction SilentlyContinue; $deadline = (Get-Date).AddSeconds(15); do { $running = @($names | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } | Where-Object State -eq ''Running''); if ($running.Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $deadline); exit 1"';
  Result := Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure StartExistingHostTask;
var
  ResultCode: Integer;
  Params: String;
begin
  Params := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = ''Stop''; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $task = Get-ScheduledTask -TaskName (''Agent Pocket Host v2 '' + $sid) -ErrorAction SilentlyContinue; if (-not $task) { $task = Get-ScheduledTask -TaskName ''Agent Pocket Host v2'' -ErrorAction SilentlyContinue }; if ($task) { Start-ScheduledTask -InputObject $task }"';
  Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure InitializeWizard;
begin
  ExistingConfig := FileExists(ExpandConstant('{localappdata}\AgentPocket\host-config.json'));
  RelayPage := CreateInputQueryPage(wpSelectDir, 'Relay', '连接到你的 Agent Pocket Relay', '输入独立 Relay 子域名。');
  RelayPage.Add('Relay 地址：', False);
  RelayPage.Values[0] := '{#MyDefaultRelayUrl}';
  RootsPage := CreateInputQueryPage(RelayPage.ID, '项目白名单', '允许手机访问的项目根目录', '多个目录使用 Windows 分号分隔。');
  RootsPage.Add('项目根目录：', False);
  RootsPage.Values[0] := ExpandConstant('{userdocs}');
  AttachmentsPage := CreateInputQueryPage(RootsPage.ID, '附件临时目录', '选择手机附件在 Host 上的临时存储位置', '建议使用空间充足的本地磁盘；附件默认在一小时后清理。');
  AttachmentsPage.Add('附件临时目录：', False);
  AttachmentsPage.Values[0] := ExpandConstant('{localappdata}\AgentPocket\attachments');
end;

function IsFirstInstall: Boolean;
begin
  Result := not ExistingConfig;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := ExistingConfig and ((PageID = RelayPage.ID) or (PageID = RootsPage.ID) or (PageID = AttachmentsPage.ID));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = RelayPage.ID then
    Result := Pos('https://', Lowercase(Trim(RelayPage.Values[0]))) = 1;
  if CurPageID = RootsPage.ID then
    Result := Trim(RootsPage.Values[0]) <> '';
  if CurPageID = AttachmentsPage.ID then
    Result := Trim(AttachmentsPage.Values[0]) <> '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
begin
  if CurStep = ssDone then
    InstallCompleted := True;
  if CurStep = ssPostInstall then
  begin
    if ExistingConfig then
    begin
      Params := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\install-desktop-plugin.ps1') +
        '" -InstallDir "' + ExpandConstant('{app}') + '"';
      if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
        RaiseException('Desktop Attach 插件升级失败。请确认 Codex Desktop 已安装。');
      Params := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\register-host-tasks.ps1') +
        '" -InstallDir "' + ExpandConstant('{app}') + '" -OnlyIfMissing -StartHost';
      if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
        RaiseException('Agent Pocket Host 计划任务升级失败。');
      exit;
    end;
    Params := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\configure-host.ps1') +
      '" -InstallDir "' + ExpandConstant('{app}') + '" -RelayUrl "' + RelayPage.Values[0] +
      '" -ProjectRoots "' + RootsPage.Values[0] + '" -AttachmentsPath "' + AttachmentsPage.Values[0] + '"';
    if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      RaiseException('Agent Pocket Host 配置失败。请检查 Relay 地址、项目目录、附件目录和 Codex CLI。');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if ExistingConfig then
  begin
    if not StopExistingHostTasks then
    begin
      Result := '无法停止正在运行的 Agent Pocket Host，请稍后重试。';
      exit;
    end;
    HostStoppedForUpgrade := True;
  end;
  if WizardSilent and (not ExistingConfig) then
    Result := '首次安装不能静默运行；请打开安装向导配置 Relay 和项目白名单。';
end;

procedure DeinitializeSetup;
begin
  if HostStoppedForUpgrade and (not InstallCompleted) then
    StartExistingHostTask;
end;
