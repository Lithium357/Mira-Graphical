# SPDX-License-Identifier: GPL-3.0-only
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$OldVersion,
  [Parameter(Mandatory = $true)][string]$NewVersion,
  [Parameter(Mandatory = $true)][string]$InstallLocation
)
$ErrorActionPreference = 'Stop'
if (-not $env:CI) { throw 'Installer UI checks require a disposable CI runner.' }
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MiraInstallerWindow {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  public static string CancelPrompt(uint owner, string oldVersion, string newVersion, string location) {
    string observed = null;
    EnumWindows((window, ignored) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (pid != owner) return true;
      var text = new StringBuilder();
      IntPtr no = IntPtr.Zero;
      EnumChildWindows(window, (child, unused) => {
        var label = new StringBuilder(4096);
        GetWindowText(child, label, label.Capacity);
        text.AppendLine(label.ToString());
        if (GetDlgCtrlID(child) == 7) no = child; // Win32 IDNO
        return true;
      }, IntPtr.Zero);
      string all = text.ToString();
      if (no != IntPtr.Zero && all.Contains(oldVersion) && all.Contains(newVersion) && all.Contains(location)) {
        observed = all;
        SendMessage(no, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return observed;
  }
}
'@
$installerProcess = Start-Process -FilePath $Installer -WindowStyle Hidden -PassThru
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $observed = $null
  while (-not $observed -and [DateTime]::UtcNow -lt $deadline) {
    $observed = [MiraInstallerWindow]::CancelPrompt($installerProcess.Id, $OldVersion, $NewVersion, $InstallLocation)
    if (-not $observed) { Start-Sleep -Milliseconds 100 }
  }
  if (-not $observed) { throw 'Expected replacement confirmation with installed version and path was not shown.' }
  if (-not $installerProcess.WaitForExit(15000)) { throw 'Installer did not exit after declining replacement.' }
  if ($installerProcess.ExitCode -ne 1602) { throw "Unexpected cancellation exit code: $($installerProcess.ExitCode)" }
  Write-Output 'Replacement confirmation displayed both versions and the existing location; declining cancelled setup.'
} finally {
  if (-not $installerProcess.HasExited) { Stop-Process -Id $installerProcess.Id -Force }
}
