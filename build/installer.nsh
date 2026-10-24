; SPDX-License-Identifier: GPL-3.0-only
!ifndef BUILD_UNINSTALLER
!include "LogicLib.nsh"
!include "WordFunc.nsh"

Var miraOldVersion
Var miraOldLocation
Var miraVersionOrder
Var miraReplaceMessage

; electron-builder initializes the matching per-user install location before this hook.
; Keep its standard uninstallOldVersion implementation so stale application files go away.
!macro customInit
  ReadRegStr $miraOldVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ReadRegStr $miraOldLocation HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $miraOldVersion != ""
    ${VersionCompare} "$miraOldVersion" "${VERSION}" $miraVersionOrder
    ${If} $miraVersionOrder == 1
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Mira Graphical $miraOldVersion is already installed. This installer contains the older version ${VERSION}. Setup will leave the newer installation unchanged."
      ${EndIf}
      SetErrorLevel 1638
      Quit
    ${EndIf}
    ${IfNot} ${Silent}
      ${If} $miraVersionOrder == 0
        StrCpy $miraReplaceMessage "Mira Graphical $miraOldVersion is already installed. Reinstall ${VERSION}?"
      ${Else}
        StrCpy $miraReplaceMessage "Mira Graphical $miraOldVersion is installed. Replace it with ${VERSION}?"
      ${EndIf}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$miraReplaceMessage$\r$\n$\r$\nInstalled in: $miraOldLocation$\r$\n$\r$\nApplication files in this folder will be replaced. App settings and project folders outside this installation folder are kept." IDYES miraReplaceConfirmed
      SetErrorLevel 1602
      Quit
      miraReplaceConfirmed:
    ${EndIf}
  ${EndIf}
!macroend
!endif

