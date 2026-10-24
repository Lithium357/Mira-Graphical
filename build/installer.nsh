; SPDX-License-Identifier: GPL-3.0-only
!ifndef BUILD_UNINSTALLER
!include "LogicLib.nsh"
!include "WordFunc.nsh"

Var miraOldVersion
Var miraOldLocation
Var miraVersionOrder
Var miraReplaceMessage
Var miraInstallMode

; Match the scope initialized by electron-builder. Machine-wide replacement also
; removes a current-user copy, so validate and confirm both before any uninstall.
!macro miraCheckPrevious ROOT_KEY SCOPE_NAME
  ReadRegStr $miraOldVersion ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ReadRegStr $miraOldLocation ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $miraOldVersion != ""
    ${VersionCompare} "$miraOldVersion" "${VERSION}" $miraVersionOrder
    ${If} $miraVersionOrder == 1
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Mira Graphical $miraOldVersion (${SCOPE_NAME}) is already installed. This installer contains the older version ${VERSION}. Setup will leave the newer installation unchanged."
      ${EndIf}
      SetErrorLevel 1638
      Quit
    ${EndIf}
    ${IfNot} ${Silent}
      ${If} $miraVersionOrder == 0
        StrCpy $miraReplaceMessage "Mira Graphical $miraOldVersion (${SCOPE_NAME}) is already installed. Reinstall ${VERSION}?"
      ${Else}
        StrCpy $miraReplaceMessage "Mira Graphical $miraOldVersion (${SCOPE_NAME}) is installed. Replace it with ${VERSION}?"
      ${EndIf}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$miraReplaceMessage$\r$\n$\r$\nInstalled in: $miraOldLocation$\r$\n$\r$\nApplication files in this folder will be replaced. App settings and project folders outside this installation folder are kept." IDYES miraReplaceConfirmed_${ROOT_KEY}
      SetErrorLevel 1602
      Quit
      miraReplaceConfirmed_${ROOT_KEY}:
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  StrCpy $miraInstallMode $installMode
  ${If} $miraInstallMode == "all"
    !insertmacro miraCheckPrevious HKLM "all users"
  ${EndIf}
  !insertmacro miraCheckPrevious HKCU "current user"
!macroend

; Don't allow the wizard to change the scope after its version check.
!macro customInstallMode
  ${If} $miraInstallMode == "all"
    StrCpy $isForceMachineInstall "1"
  ${Else}
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
!macroend
!endif
