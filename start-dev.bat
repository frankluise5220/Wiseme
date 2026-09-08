@echo off
setlocal

cd /d "%~dp0"

echo [mmh] Checking port 7777...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777" ^| findstr "LISTENING"') do (
  echo [mmh] Stopping process %%a using port 7777...
  taskkill /F /PID %%a >nul 2>nul
)

echo [mmh] Generating Prisma client...
call npx prisma generate
if errorlevel 1 (
  echo [mmh] Prisma generate failed.
  pause
  exit /b 1
)

echo [mmh] Starting dev server at http://localhost:7777 ...
call npm run dev

pause
