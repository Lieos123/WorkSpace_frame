@echo off
setlocal
cd /d "%~dp0"
node "%~dp0ws.mjs" board --open
set "boardExit=%errorlevel%"
if not "%boardExit%"=="0" pause
exit /b %boardExit%
