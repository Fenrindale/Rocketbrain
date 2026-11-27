[Setup]
AppId={{5EAF7389-6EC3-47A1-A502-F5A857DA42CA}
AppName=Rocketbrain Desktop
AppVersion={#DesktopVersion}
AppPublisher=Rocketbrain
AppPublisherURL=https://github.com/Fenrindale/Rocketbrain
AppSupportURL=https://github.com/Fenrindale/Rocketbrain/issues
DefaultDirName={localappdata}\Programs\Rocketbrain Desktop
DefaultGroupName=Rocketbrain Desktop
UninstallDisplayIcon={app}\Rocketbrain.exe
PrivilegesRequired=lowest
AppMutex=rocketbrain-desktop
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
CreateUninstallRegKey=UseShellIntegration
Uninstallable=UseShellIntegration
CloseApplications=no
RestartApplications=no
OutputDir={#OutputPath}
OutputBaseFilename=RocketbrainDesktop-{#DesktopVersion}-win32-x64-setup
VersionInfoVersion={#InstallerFileVersion}
VersionInfoDescription=Rocketbrain Desktop Preview
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#PayloadPath}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Rocketbrain Desktop"; Filename: "{app}\Rocketbrain.exe"; WorkingDir: "{app}"; AppUserModelID: "Rocketbrain.Desktop"; Check: UseShellIntegration

[Run]
Filename: "{app}\Rocketbrain.exe"; Description: "Open Rocketbrain Desktop"; Flags: nowait postinstall skipifsilent

[Code]
function UseShellIntegration: Boolean;
begin
  Result := ExpandConstant('{param:RB_ISOLATED|0}') <> '1';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not UseShellIntegration) then
    if not SaveStringToFile(ExpandConstant('{app}\.rocketbrain-isolated'), 'Rocketbrain isolated installation', False) then
      RaiseException('Could not mark the isolated Rocketbrain installation.');
end;
