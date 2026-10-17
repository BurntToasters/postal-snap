; Postal Snap NSIS installer hooks.
;
; Tauri inserts these macros into the generated installer:
;   NSIS_HOOK_PREINSTALL    - Section Install, before the app binary is copied
;   NSIS_HOOK_POSTINSTALL   - Section Install, after files are copied
;   NSIS_HOOK_PREUNINSTALL  - Section Uninstall, after the app-data choice is made
; PREINSTALL runs after the WebView2 section, so a machine without a usable
; WebView2 may still fail there first. The build-number gate below is therefore
; a second line of defense, and the Windows 10 22H2 (10.0.19045) floor remains
; documented in AGENTS.md and docs/RELEASE_CHECKLIST.md. WinVer.nsh ships
; `${AtLeastBuild}` in the NSIS 3.11 toolchain Tauri bundles on Windows.
;
; Default apps use an app-specific ProgID and capabilities. The shared
; Software\Classes\mailto key is never written or deleted.

!include "LogicLib.nsh"
!include "WinVer.nsh"

!define POSTAL_SNAP_MIN_WINDOWS_BUILD 19045
!define POSTAL_SNAP_APP_NAME "Postal Snap"
!define POSTAL_SNAP_PROGID "PostalSnap.mailto"
!define POSTAL_SNAP_CAPS_KEY "Software\Postal Snap\Capabilities"
!define POSTAL_SNAP_REGISTERED_APPS "Software\RegisteredApplications"
!define POSTAL_SNAP_LEGACY_MAILTO "Software\Classes\mailto"

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastBuild} ${POSTAL_SNAP_MIN_WINDOWS_BUILD}
    MessageBox MB_OK|MB_ICONSTOP "Postal Snap requires Windows 10 22H2 (build 19045) or newer."
    Abort
  ${EndIf}
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
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove only app-owned registration on a real uninstall. In-place upgrades
  ; reuse the uninstaller with /UPDATE and reinstall these keys right after.
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\${POSTAL_SNAP_PROGID}"
    DeleteRegKey HKCU "${POSTAL_SNAP_CAPS_KEY}"
    DeleteRegValue HKCU "${POSTAL_SNAP_REGISTERED_APPS}" "${POSTAL_SNAP_APP_NAME}"

    ; Legacy 0.5.0 prerelease installs wrote the shared mailto command. Remove
    ; it only while it still points at this install, never the whole key.
    ReadRegStr $0 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\shell\open\command" ""
    ${If} $0 == '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
      DeleteRegKey HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\shell\open\command"
      ReadRegStr $1 HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\DefaultIcon" ""
      ${If} $1 == "$INSTDIR\${MAINBINARYNAME}.exe,0"
        DeleteRegKey HKCU "${POSTAL_SNAP_LEGACY_MAILTO}\DefaultIcon"
      ${EndIf}
    ${EndIf}
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
