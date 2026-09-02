#define MyAppName "Agent Pocket Host"
#ifndef MyAppVersion
#define MyAppVersion "0.2.0"
#endif
#define MyAppPublisher "Agent Pocket Contributors"

[Setup]
AppId={{5B7113C5-B584-45A2-8478-E24C17E63D26}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
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
Name: "{group}\绑定这台 Windows 电脑"; Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\enroll-host.ps1"""
Name: "{group}\检查 Agent Pocket Host 更新"; Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\check-host-update.ps1"" -InstallDir ""{app}"""

[Run]
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\enroll-host.ps1"""; Description: "现在绑定这台电脑"; Flags: postinstall skipifsilent nowait; Check: IsFirstInstall

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall-host.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "AgentPocketHostUninstall"

[Code]
var
  RelayPage: TInputQueryWizardPage;
  RootsPage: TInputQueryWizardPage;
  AttachmentsPage: TInputQueryWizardPage;
  ExistingConfig: Boolean;

procedure InitializeWizard;
begin
  ExistingConfig := FileExists(ExpandConstant('{localappdata}\AgentPocket\host-config.json'));
  RelayPage := CreateInputQueryPage(wpSelectDir, 'Relay', '连接到你的 Agent Pocket Relay', '输入独立 Relay 子域名。');
  RelayPage.Add('Relay 地址：', False);
  RelayPage.Values[0] := 'https://relay.example.com';
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
  if CurStep = ssPostInstall then
  begin
    if ExistingConfig then
    begin
      Params := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\register-host-tasks.ps1') +
        '" -InstallDir "' + ExpandConstant('{app}') + '" -OnlyIfMissing';
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
  if WizardSilent and (not ExistingConfig) then
    Result := '首次安装不能静默运行；请打开安装向导配置 Relay 和项目白名单。';
end;
