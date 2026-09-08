; MMH NSIS customization.
;
; 1. Default install directory: D:\MMH when the D: drive exists, otherwise
;    Program Files (x64). The value is written into the registry key that
;    electron-builder reads during .onInit to override the default INSTALL_ROOT.
; 2. Uninstall keeps user data: the app stores its database under
;    $INSTDIR\data. electron-builder removes $INSTDIR recursively, so we move
;    data aside before that and restore it afterwards.

!macro preInit
  IfFileExists "D:\" 0 +3
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\MMH"
  Goto +2
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\MMH"
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\data\*.*" 0 +3
  Rename "$INSTDIR\data" "$TEMP\MMH-data-backup"
  Goto +1
!macroend

!macro customUnInstallSection
  Section "-MMH user data"
    IfFileExists "$TEMP\MMH-data-backup\*.*" 0 +3
    CreateDirectory "$INSTDIR"
    Rename "$TEMP\MMH-data-backup" "$INSTDIR\data"
    Goto +1
  SectionEnd
!macroend
