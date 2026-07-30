[Setup]
AppName=Attendance Processor
AppVersion=4.0
DefaultDirName={autopf}\AttendanceProcessor
DefaultGroupName=Attendance Processor
OutputDir=dist
OutputBaseFilename=AttendanceProcessor-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=lowest

[Files]
Source: "dist\AttendanceProcessor\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Attendance Processor"; Filename: "{app}\AttendanceProcessor.exe"
Name: "{autodesktop}\Attendance Processor"; Filename: "{app}\AttendanceProcessor.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"
