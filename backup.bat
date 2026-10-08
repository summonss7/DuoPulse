@echo off
rem ============================================================
rem  DuoPulse - project backup
rem  Copies the project into backups\backup_YYYY-MM-DD_HH-MM-SS
rem  Usage: double-click backup.bat  (or "backup.bat -q" - no pause)
rem ============================================================
setlocal
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set "TS=%%i"
set "DEST=%~dp0backups\backup_%TS%"

robocopy "%~dp0." "%DEST%" /E /XD backups node_modules target dist .git /XF *.log /NFL /NDL /NJH /NJS /NP >nul
if %ERRORLEVEL% LEQ 7 (
    echo Backup OK: %DEST%
) else (
    echo Backup FAILED, robocopy code %ERRORLEVEL%
)

if /i "%~1"=="-q" goto :done
pause
:done
endlocal
