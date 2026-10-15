@echo off
REM Register the two WorkSpace night tasks in Windows Task Scheduler.
REM Double-click is fine. No admin rights needed.
REM Real work lives in register.mjs (UTF-16 conversion + node path injection);
REM this wrapper only exists so it can be started from Explorer.
REM ASCII only on purpose: batch files under a GBK console mangle non-ASCII.
setlocal
set RUNNER=D:\WorkSpace\_night\register.mjs

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH. Install Node.js or add it to PATH.
  pause
  exit /b 1
)
if not exist "%RUNNER%" (
  echo [ERROR] not found: %RUNNER%
  pause
  exit /b 1
)

node "%RUNNER%"
echo.
pause
