param([int]$ProcId, [string]$Mode)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class M32 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetMenuStringW(IntPtr h, uint item, StringBuilder sb, int max, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$sb = New-Object System.Text.StringBuilder(256)
$found = New-Object System.Collections.ArrayList
$cb = {
  param($h, $lp)
  $pid2 = 0
  [M32]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pid2 -eq $ProcId) {
    $sb.Clear() | Out-Null
    [M32]::GetClassNameW($h, $sb, 256) | Out-Null
    if ($sb.ToString() -eq "#32768") { [void]$found.Add($h) }
  }
  return $true
}
[M32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($Mode -eq "items") {
  foreach ($m in $found) {
    $hm = [M32]::GetMenu($m)
    $cnt = [M32]::GetMenuItemCount($hm)
    Write-Output ("MENU hwnd=" + $m + " hmenu=" + $hm + " items=" + $cnt)
    for ($i = 0; $i -lt $cnt; $i++) {
      $s = New-Object System.Text.StringBuilder(256)
      [M32]::GetMenuStringW($hm, [uint32]$i, $s, 256, 0x400) | Out-Null
      Write-Output ("ITEM: [" + $s.ToString() + "]")
    }
  }
  if ($found.Count -eq 0) { Write-Output "NO-MENU-WINDOW" }
} elseif ($Mode -eq "close") {
  foreach ($m in $found) {
    [M32]::PostMessageW($m, 0x0100, [IntPtr]27, [IntPtr]::Zero) | Out-Null
    [M32]::PostMessageW($m, 0x0101, [IntPtr]27, [IntPtr]::Zero) | Out-Null
  }
  Write-Output ("posted-esc: " + $found.Count)
}
