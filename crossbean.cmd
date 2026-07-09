@echo off
REM Double-click launcher for crossbean.
REM Opens the native app window (no console needed after launch).
setlocal
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
where bun >nul 2>nul || (
  echo Bun runtime not found. Install from https://bun.sh and try again.
  pause
  exit /b 1
)
start "" /b bun run main.ts
exit /b 0
