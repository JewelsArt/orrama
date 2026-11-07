; Orrama's hooks into Tauri's NSIS uninstaller (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; Uninstalling never deletes notes. The uninstaller's own "Delete the application data" box
; (Tauri's template) removes %LOCALAPPDATA%\com.orrama.desktop: the database, the logs, the
; server's port and the backups made before an upgrade. The notes are elsewhere, in ~/Orrama or
; the folder the person chose, and Orrama refuses a notes folder inside that data folder
; (firstRun.ts lookAtFolder, backup.ts lookAtTarget), so nothing here can reach them.
;
; With the box ticked the app's two secrets go too: the Credential Manager entry the app made
; (secrets.rs: service com.orrama.desktop, user "server secrets"; the keyring's target name is
; "<user>.<service>"). Left behind, a reinstall would read them again over an empty database.
; Never on an update (/UPDATE): the updater uninstalls the old version on its way to the new one.
;
; A silent uninstall has no box to tick: /DELETEAPPDATA ticks it. The release workflow's install
; check runs `uninstall.exe /S /DELETEAPPDATA` (scripts/install-check.mjs).

!macro NSIS_HOOK_PREUNINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "/DELETEAPPDATA" $R0
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
  ClearErrors
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; CRED_TYPE_GENERIC = 1. A missing entry is fine: nothing to remove.
    System::Call 'advapi32::CredDeleteW(w "server secrets.com.orrama.desktop", i 1, i 0) i .r0'
  ${EndIf}
!macroend
