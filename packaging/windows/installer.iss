; Inno Setup script for crossbean (Windows x64).
; Build: iscc packaging\windows\installer.iss
; Expects dist\crossbean-windows-x64\ to exist (bun run scripts/build-release.ts)
; and optionally packaging\windows\icon.ico (generated from assets\icon.svg).

#define MyAppName "crossbean"
#define MyAppVersion "0.1.1"
#define MyAppPublisher "crossbean contributors"
#define MyAppExeName "crossbean.exe"
#define DistDir "..\..\dist\crossbean-windows-x64"

[Setup]
AppId={{8E7A1F2C-5B3D-4A96-9C1E-CB0552BEA411}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=crossbean-setup-windows-x64
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
#ifexist "icon.ico"
SetupIconFile=icon.ico
#endif

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "{#DistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

; User data (%APPDATA%\crossbean) is intentionally left behind on uninstall.
