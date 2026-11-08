@echo off
rem Double-click this to start Craftie. Downloads what it needs the first time.
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || goto getnode
node -e "process.exit(parseInt(process.versions.node) < 23 ? 1 : 0)" || goto getnode
goto deps
:getnode
if not exist "runtime\node\node.exe" (
  echo First run: downloading Node.js ^(one time only^)...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1" || ( echo Could not download Node.js. Install it from nodejs.org & pause & exit /b 1 )
)
set "NODE=%~dp0runtime\node\node.exe"
set "PATH=%~dp0runtime\node;%PATH%"
:deps
if not exist node_modules (
  echo First run: installing parts ^(one time only^)...
  call npm install --no-audit --no-fund
)
"%NODE%" src\app.ts
pause
