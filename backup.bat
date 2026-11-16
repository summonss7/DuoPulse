@echo off
rem ============================================================
rem  DuoPulse - project backup
rem  Copies the project into backups\backup_YYYY-MM-DD_HH-MM-SS
rem  Usage: double-click backup.bat  (or "backup.bat -q" - no pause)
rem  aila-423: excluded regenerable builds/e2e/duopulse-updates/
rem  test-results (each copy weighed 10.3 GB, dispatcher backups ate
rem  ~100 GB/day; source + .git fit in ~1.6 GB) + rotation keep 3,
rem  like Aila backup.ps1 - backups can no longer eat the disk.
rem ============================================================
setlocal
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set "TS=%%i"
set "DEST=%~dp0backups\backup_%TS%"

robocopy "%~dp0." "%DEST%" /E /XD backups node_modules target dist .git builds e2e duopulse-updates test-results /XF *.log /NFL /NDL /NJH /NJS /NP >nul
if %ERRORLEVEL% LEQ 7 (
    echo Backup OK: %DEST%
) else (
    echo Backup FAILED, robocopy code %ERRORLEVEL%
)

rem rotation: keep the last 3 backups (old ones are removed right
rem after a successful copy, without waiting for cleanup.bat)
powershell -NoProfile -Command "$old = @(Get-ChildItem -LiteralPath '%~dp0backups' -Directory -Filter 'backup_*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 3); foreach ($o in $old) { Write-Host ('rotating out: ' + $o.Name); Remove-Item -LiteralPath $o.FullName -Recurse -Force -ErrorAction SilentlyContinue }"

if /i "%~1"=="-q" goto :done
pause
:done
endlocal
