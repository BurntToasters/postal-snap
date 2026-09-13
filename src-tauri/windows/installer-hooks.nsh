; Postal Snap NSIS installer hooks.
;
; Tauri inserts these macros into the generated installer:
;   NSIS_HOOK_PREINSTALL   - Section Install, before the app binary is copied
;   NSIS_HOOK_PREUNINSTALL  - Section Uninstall, after the app-data choice is made
; PREINSTALL runs after the WebView2 section, so a machine without a usable
; WebView2 may still fail there first. The build-number gate below is therefore
; a second line of defense, and the Windows 10 22H2 (10.0.19045) floor remains
; documented in AGENTS.md and docs/RELEASE_CHECKLIST.md. WinVer.nsh ships
; `${AtLeastBuild}` in the NSIS 3.11 toolchain Tauri bundles on Windows.

!include "LogicLib.nsh"
!include "WinVer.nsh"

!define POSTAL_SNAP_MIN_WINDOWS_BUILD 19045

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastBuild} ${POSTAL_SNAP_MIN_WINDOWS_BUILD}
    MessageBox MB_OK|MB_ICONSTOP "Postal Snap requires Windows 10 22H2 (build 19045) or newer."
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
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
