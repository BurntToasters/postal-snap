; Postal Snap NSIS installer hooks.
;
; Tauri inserts these macros into the generated installer:
;   NSIS_HOOK_PREINSTALL    - Section Install, before the app binary is copied
;   NSIS_HOOK_POSTINSTALL   - Section Install, after files are copied
;   NSIS_HOOK_PREUNINSTALL  - Section Uninstall, after the app-data choice is made
;   NSIS_HOOK_POSTUNINSTALL - Section Uninstall, after Tauri's own cleanup
; PREINSTALL runs after the WebView2 section, so a machine without a usable
; WebView2 may still fail there first. The build-number gate below is therefore
; a second line of defense, and the Windows 10 22H2 (10.0.19045) floor remains
; documented in AGENTS.md and docs/RELEASE_CHECKLIST.md. WinVer.nsh ships
; `${AtLeastBuild}` in the NSIS 3.11 toolchain Tauri bundles on Windows.
;
; Default apps use an app-specific ProgID and capabilities. Tauri's deep-link
; template still writes the shared Software\Classes\mailto key (the scheme must
; stay configured for mailto launches). Another client's handler is backed up
; in PREINSTALL and restored in POSTINSTALL, so it survives install, upgrade,
; and uninstall.

!include "LogicLib.nsh"
!include "WinVer.nsh"

!define POSTAL_SNAP_MIN_WINDOWS_BUILD 19045
!define POSTAL_SNAP_APP_NAME "Postal Snap"
!define POSTAL_SNAP_PROGID "PostalSnap.mailto"
!define POSTAL_SNAP_CAPS_KEY "Software\Postal Snap\Capabilities"
!define POSTAL_SNAP_REGISTERED_APPS "Software\RegisteredApplications"
!define POSTAL_SNAP_LEGACY_MAILTO "Software\Classes\mailto"
!define POSTAL_SNAP_BACKUP_KEY "Software\Postal Snap\MailtoBackup"
; Tauri writes this default value for the shared key (BUNDLEID run.rosie.snap).
!define POSTAL_SNAP_MAILTO_DEFAULT "URL:run.rosie.snap protocol"
; Command tail shared by every Postal Snap install folder.
!define POSTAL_SNAP_COMMAND_SUFFIX '${MAINBINARYNAME}.exe" "%1"'

; Sets $R8 to "1" when the command in $R0 is Postal Snap's, from any folder.
; Only the command decides; other clients may keep Tauri's default value.
!macro POSTAL_SNAP_IS_OURS_COMMAND
  StrCpy $R8 "0"
  StrLen $R7 '${POSTAL_SNAP_COMMAND_SUFFIX}'
  StrCpy $R6 $R0 "" "-$R7"
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ${OrIf} $R6 == '${POSTAL_SNAP_COMMAND_SUFFIX}'
    StrCpy $R8 "1"
  ${EndIf}
!macroend

; Copy another client's shared mailto handler to an app-owned key. Ours is
; skipped, so a stale backup is never replaced by Postal Snap's own command.
!macro POSTAL_SNAP_BACKUP_MAILTO
  ReadRegStr $R0 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\shell\open\command" ""
  ReadRegStr $R1 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}" ""
  !insertmacro POSTAL_SNAP_IS_OURS_COMMAND
  ${If} $R0 != ""
  ${AndIf} $R8 != "1"
    ; Presence flags let restore delete values the other client never had.
    StrCpy $R2 "0"
    ClearErrors
    ReadRegStr $R4 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}" "URL Protocol"
    IfErrors +2 0
    StrCpy $R2 "1"
    StrCpy $R3 "0"
    ClearErrors
    ReadRegStr $R5 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\DefaultIcon" ""
    IfErrors +2 0
    StrCpy $R3 "1"
    WriteRegStr HKCU "${POSTAL_SNAP_BACKUP_KEY}" "Default" $R1
    WriteRegStr HKCU "${POSTAL_SNAP_BACKUP_KEY}" "HasURLProtocol" $R2
    WriteRegStr HKCU "${POSTAL_SNAP_BACKUP_KEY}" "HasDefaultIcon" $R3
    WriteRegStr HKCU "${POSTAL_SNAP_BACKUP_KEY}" "DefaultIcon" $R5
    WriteRegStr HKCU "${POSTAL_SNAP_BACKUP_KEY}" "Command" $R0
    WriteRegStr HKCU "${POSTAL_SNAP_BACKUP_KEY}" "Captured" "1"
  ${EndIf}
!macroend

; Write the backed-up shared handler back over Tauri's registration. Does nothing
; unless a backup was captured.
!macro POSTAL_SNAP_RESTORE_MAILTO
  ReadRegStr $R0 HKCU "${POSTAL_SNAP_BACKUP_KEY}" "Captured"
  ${If} $R0 == "1"
    ReadRegStr $R1 HKCU "${POSTAL_SNAP_BACKUP_KEY}" "Default"
    WriteRegStr HKCU "${POSTAL_SNAP_LEGACY_MAILTO}" "" $R1
    ReadRegStr $R2 HKCU "${POSTAL_SNAP_BACKUP_KEY}" "HasURLProtocol"
    ${If} $R2 == "1"
      WriteRegStr HKCU "${POSTAL_SNAP_LEGACY_MAILTO}" "URL Protocol" ""
    ${Else}
      DeleteRegValue HKCU "${POSTAL_SNAP_LEGACY_MAILTO}" "URL Protocol"
    ${EndIf}
    ReadRegStr $R3 HKCU "${POSTAL_SNAP_BACKUP_KEY}" "HasDefaultIcon"
    ${If} $R3 == "1"
      ReadRegStr $R4 HKCU "${POSTAL_SNAP_BACKUP_KEY}" "DefaultIcon"
      WriteRegStr HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\DefaultIcon" "" $R4
    ${Else}
      DeleteRegKey HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\DefaultIcon"
    ${EndIf}
    ReadRegStr $R5 HKCU "${POSTAL_SNAP_BACKUP_KEY}" "Command"
    WriteRegStr HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\shell\open\command" "" $R5
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastBuild} ${POSTAL_SNAP_MIN_WINDOWS_BUILD}
    MessageBox MB_OK|MB_ICONSTOP "Postal Snap requires Windows 10 22H2 (build 19045) or newer."
    Abort
  ${EndIf}
  !insertmacro POSTAL_SNAP_BACKUP_MAILTO
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Register after files are copied, so an interrupted install never leaves
  ; a handler pointing at a missing binary. Windows keeps the user's own choice.
  WriteRegStr HKCU "Software\Classes\${POSTAL_SNAP_PROGID}" "" "URL:MailTo Protocol"
  WriteRegStr HKCU "Software\Classes\${POSTAL_SNAP_PROGID}" "FriendlyTypeName" "${POSTAL_SNAP_APP_NAME} mailto link"
  WriteRegStr HKCU "Software\Classes\${POSTAL_SNAP_PROGID}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${POSTAL_SNAP_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\${POSTAL_SNAP_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "${POSTAL_SNAP_CAPS_KEY}" "ApplicationName" "${POSTAL_SNAP_APP_NAME}"
  WriteRegStr HKCU "${POSTAL_SNAP_CAPS_KEY}" "ApplicationDescription" "Calm, minimal desktop email."
  WriteRegStr HKCU "${POSTAL_SNAP_CAPS_KEY}" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "${POSTAL_SNAP_CAPS_KEY}\URLAssociations" "mailto" "${POSTAL_SNAP_PROGID}"
  WriteRegStr HKCU "${POSTAL_SNAP_REGISTERED_APPS}" "${POSTAL_SNAP_APP_NAME}" "${POSTAL_SNAP_CAPS_KEY}"
  ; Tauri's shared mailto writes ran earlier in this section; undo them for
  ; another client's handler.
  !insertmacro POSTAL_SNAP_RESTORE_MAILTO
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove only app-owned registration on a real uninstall. In-place upgrades
  ; reuse the uninstaller with /UPDATE and reinstall these keys right after.
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\${POSTAL_SNAP_PROGID}"
    DeleteRegKey HKCU "${POSTAL_SNAP_CAPS_KEY}"
    DeleteRegValue HKCU "${POSTAL_SNAP_REGISTERED_APPS}" "${POSTAL_SNAP_APP_NAME}"

    ; Tauri deletes the whole shared key only while its command is ours. If the
    ; backed-up handler is still captured and the command is ours, restore the
    ; other client first so Tauri's check fails and the key is kept.
    ReadRegStr $R0 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\shell\open\command" ""
    !insertmacro POSTAL_SNAP_IS_OURS_COMMAND
    ${If} $R8 == "1"
      !insertmacro POSTAL_SNAP_RESTORE_MAILTO
    ${EndIf}
    DeleteRegKey HKCU "${POSTAL_SNAP_BACKUP_KEY}"
  ${EndIf}
  ; Delete mailbox passwords only on a real uninstall that also removes app
  ; data. In-place upgrades reuse the uninstaller with /UPDATE, and users who
  ; keep app data keep their saved accounts. The binary call is guarded so a
  ; missing or mismatched executable can never abort the uninstall.
  ${If} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 postal_snap_credentials_done
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --cleanup-credentials' $0
      ClearErrors
    postal_snap_credentials_done:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Earlier 0.5.0 prerelease hooks deleted the command and icon but kept the
  ; shared key. Remove that skeleton only when it still carries Tauri's default.
  ${If} $UpdateMode <> 1
    ReadRegStr $R0 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\shell\open\command" ""
    ReadRegStr $R1 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}" ""
    ${If} $R0 == ""
    ${AndIf} $R1 == "${POSTAL_SNAP_MAILTO_DEFAULT}"
      DeleteRegKey HKCU "${POSTAL_SNAP_LEGACY_MAILTO}"
    ${EndIf}
  ${EndIf}
!macroend
