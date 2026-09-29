[Setup]
AppName=Attendance Processor Pro
AppVersion=12.1
DefaultDirName={autopf}\AttendanceProcessor
DefaultGroupName=Attendance Processor Pro
OutputDir=dist
OutputBaseFilename=AttendanceProcessor-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=lowest
SetupIconFile=app_icon.ico

[Files]
Source: "dist\AttendanceProcessor\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Attendance Processor Pro"; Filename: "{app}\AttendanceProcessor.exe"
Name: "{autodesktop}\Attendance Processor Pro"; Filename: "{app}\AttendanceProcessor.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"
