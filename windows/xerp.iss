; 小林进销存 Windows 安装包（Inno Setup 6）。由 windows\build-windows.ps1 调用，传入 AppVersion / StageDir / OutDir
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6A7E2C51-3B9D-4F0A-9E21-58C4D7B0A3F2}
AppName=小林进销存
AppVersion={#AppVersion}
AppVerName=小林进销存 {#AppVersion}
AppPublisher=小林进销存
AppPublisherURL=http://101.201.141.121/xerp/
AppSupportURL=https://github.com/desstg/XLerp/issues
DefaultDirName={autopf}\XLerp
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=xlerp-{#AppVersion}-windows-x64-setup
SetupIconFile={#StageDir}\xerp.ico
UninstallDisplayIcon={app}\xerp.ico
UninstallDisplayName=小林进销存
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
ShowLanguageDialog=no

[Languages]
Name: "zh"; MessagesFile: "{#StageDir}\ChineseSimplified.isl"

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\xerp.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\XERP"

[Icons]
; 快捷方式指向 XLerp.exe（Electron 原生窗口），不是浏览器
Name: "{autoprograms}\小林进销存\打开 小林进销存"; Filename: "{app}\XLerp.exe"; Parameters: "{code:ExeArgs}"; IconFilename: "{app}\xerp.ico"
Name: "{autoprograms}\小林进销存\数据目录"; Filename: "{code:DataDir}"
Name: "{autoprograms}\小林进销存\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{autoprograms}\小林进销存\卸载 小林进销存"; Filename: "{uninstallexe}"
Name: "{autodesktop}\小林进销存"; Filename: "{app}\XLerp.exe"; Parameters: "{code:ExeArgs}"; IconFilename: "{app}\xerp.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式"; GroupDescription: "快捷方式："

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\xerp-service.ps1"" -Action install -AppDir ""{app}"" -DataDir ""{code:DataDir}"" -Port {code:GetPort} -Mode {code:GetMode} -ClientServer ""{code:GetClientServer}"""; StatusMsg: "正在启动 小林进销存 服务…"; Flags: runhidden waituntilterminated
Filename: "{app}\XLerp.exe"; Parameters: "{code:ExeArgs} --trigger-startup"; Description: "打开 小林进销存"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\xerp-service.ps1"" -Action uninstall -AppDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopXerp"

[Code]
var
  CfgPage: TInputQueryWizardPage;
  ModePage: TInputOptionWizardPage;
  Upgrading: Boolean;

function DataDir(Param: String): String;
var
  D: String;
begin
  // 安装时可以改数据目录（比如放到 D 盘），升级时沿用旧的
  D := Trim(CfgPage.Values[4]);
  if D = '' then
    D := ExpandConstant('{commonappdata}\XERP');
  D := RemoveBackslashUnlessRoot(D);
  Result := D;
end;

function GetPort(Param: String): String;
begin
  Result := Trim(CfgPage.Values[0]);
end;

// server = 本机存数据（默认）；client = 连已有服务器
function GetMode(Param: String): String;
begin
  // TInputOptionWizardPage 里第 2 项被选中就是客户端模式
  if ModePage.Values[1] then
    Result := 'client'
  else
    Result := 'server';
end;

function GetClientServer(Param: String): String;
begin
  Result := Trim(CfgPage.Values[3]);
end;

// 桌面程序（XLerp.exe = Electron 窗口）的启动参数：模式、端口、服务器地址、数据目录
// 一律用 --key=value 形式：Chromium 会把「--server http://x」这种独立参数当成非法开关，进程直接退出
function ExeArgs(Param: String): String;
begin
  Result := '--mode=' + GetMode('') + ' --port=' + GetPort('');
  if GetMode('') = 'client' then
    Result := Result + ' --server=' + GetClientServer('');
  Result := Result + ' --data="' + DataDir('') + '"';
end;

procedure InitializeWizard();
begin
  // 第一步：选运行模式（放在服务设置前面，先问清这个再决定服务怎么装）
  ModePage := CreateInputOptionPage(wpSelectDir, '运行模式',
    '这台电脑是怎么用 小林进销存？',
    '服务器模式：数据存在这台电脑，手机、别的电脑都可以连它。' + #13#10 +
    '客户端模式：连一台已经装好的服务器（比如 NAS 上的），本机不存业务数据。' + #13#10 +
    '装好后工作台会显示当前模式。要改模式，重新运行这个安装程序即可，数据不会丢。',
    True, False);
  ModePage.Add('服务器模式（数据存本机，推荐单机使用）');
  ModePage.Add('客户端模式（连接已有服务器）');
  ModePage.Values[0] := True;   // 默认选服务器模式

  CfgPage := CreateInputQueryPage(ModePage.ID, '服务设置',
    '小林进销存 以独立窗口运行；后台服务开机自动启动、不用登录 Windows，手机和别的电脑也能连。',
    '局域网里的其他电脑用浏览器访问「http://本机IP:端口」即可使用。' + #13#10 +
    '数据目录默认在系统盘，可以改成别的盘（比如 D:\XERP），卸载或升级都不会删除。');
  CfgPage.Add('服务端口：', False);
  CfgPage.Add('管理员密码（账号 admin，至少 6 位）：', True);
  CfgPage.Add('再次输入密码：', True);
  CfgPage.Add('服务器地址（客户端模式才需要，如 http://192.168.1.10:8686）：', False);
  CfgPage.Add('数据目录（留空 = ' + ExpandConstant('{commonappdata}') + '\XERP）：', False);
  CfgPage.Values[0] := GetPreviousData('Port', '8686');
  // CfgPage 建好之后才能判断「是不是升级」（要读数据目录）
  Upgrading := FileExists(DataDir('') + '\erp.db');
  if Upgrading then
  begin
    CfgPage.Edits[1].Enabled := False; CfgPage.Edits[2].Enabled := False;
    CfgPage.PromptLabels[1].Caption := '管理员密码：检测到已有数据，沿用原来的账号密码';
    CfgPage.PromptLabels[2].Caption := '';
    CfgPage.Edits[2].Visible := False;
    // 已有数据就别让改数据目录了，免得找不到原来的库
    CfgPage.Values[4] := ExpandConstant('{commonappdata}') + '\XERP';
    CfgPage.Edits[4].Enabled := False;
    CfgPage.PromptLabels[4].Caption := '数据目录：检测到已有数据，沿用原来的目录';
  end;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'Port', GetPort(''));
end;

// 静默安装（/SILENT、/VERYSILENT）时不要弹自定义页面，全部用默认值：
// 服务器模式、8686 端口、数据目录 {commonappdata}\XERP。CI 和批量部署都靠这个。
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if WizardSilent then
    Result := (PageID = ModePage.ID) or (PageID = CfgPage.ID);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;
  if CurPageID = CfgPage.ID then
  begin
    P := StrToIntDef(Trim(CfgPage.Values[0]), 0);
    if (P < 1024) or (P > 65535) then
    begin
      MsgBox('端口需在 1024 ~ 65535 之间，一般用默认的 8686 即可。', mbError, MB_OK);
      Result := False; Exit;
    end;
    if not Upgrading then
    begin
      if Length(CfgPage.Values[1]) < 6 then
      begin
        MsgBox('管理员密码至少 6 位。', mbError, MB_OK);
        Result := False; Exit;
      end;
      if CfgPage.Values[1] <> CfgPage.Values[2] then
      begin
        MsgBox('两次输入的密码不一致。', mbError, MB_OK);
        Result := False; Exit;
      end;
    end;
    // 客户端模式必须填服务器地址，装完就该能连上，别让人装完才发现没填
    if GetMode('') = 'client' then
    begin
      if Trim(CfgPage.Values[3]) = '' then
      begin
        MsgBox('选了客户端模式，请填写服务器地址，例如 http://192.168.1.10:8686', mbError, MB_OK);
        Result := False; Exit;
      end;
      if (Pos('http://', Lowercase(CfgPage.Values[3])) <> 1) and (Pos('https://', Lowercase(CfgPage.Values[3])) <> 1) then
      begin
        MsgBox('服务器地址要以 http:// 开头，例如 http://192.168.1.10:8686', mbError, MB_OK);
        Result := False; Exit;
      end;
    end;
  end;
end;

// 升级前先停掉正在运行的服务，否则 node.exe 被占用无法覆盖
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Old: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6A7E2C51-3B9D-4F0A-9E21-58C4D7B0A3F2}_is1', 'InstallLocation', Old) then
    if FileExists(AddBackslash(Old) + 'xerp-service.ps1') then
      Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + AddBackslash(Old) + 'xerp-service.ps1" -Action stop -AppDir "' + RemoveBackslash(Old) + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Lines: TArrayOfString;
  Pwd: String;
begin
  // 首次安装：把管理员密码交给服务端（[Run] 里启动服务前写好），首次启动读取后立即删除
  if (CurStep = ssInstall) and (not Upgrading) then
  begin
    ForceDirectories(DataDir(''));
    Pwd := CfgPage.Values[1];
    // 静默安装拿不到页面输入，用环境变量 XERP_ADMIN_PASSWORD，再不行用初始密码
    if Pwd = '' then Pwd := GetEnv('XERP_ADMIN_PASSWORD');
    if Pwd = '' then Pwd := 'xlerp123';
    SetArrayLength(Lines, 1); Lines[0] := Pwd;
    SaveStringsToUTF8File(DataDir('') + '\admin-password.txt', Lines, False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    MsgBox('小林进销存 已卸载。业务数据仍保留在 ' + ExpandConstant('{commonappdata}\XERP') + '，重新安装即可继续使用；确定不要了可以手动删除该文件夹。', mbInformation, MB_OK);
end;
