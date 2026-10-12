@echo off
setlocal DisableDelayedExpansion
rem Launch only the fixed sibling setup script in the current interactive window.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0setup-arcane.ps1" -Launch
set "ARCANE_LAUNCH_EXIT=%ERRORLEVEL%"
if not "%ARCANE_LAUNCH_EXIT%"=="0" (
    echo.
    echo Arcane could not launch. Read the message above and docs\build\FIRST_RUN.md.
    echo Use setup-arcane.ps1 with explicit -InstallDependencies or -Prepare if needed.
    pause
)
exit /b %ARCANE_LAUNCH_EXIT%
