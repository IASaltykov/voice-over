@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer was not found in PATH.
  pause
  exit /b 3
)
if not exist "node_modules" (
  echo Installing Node.js dependencies...
  call npm ci
  if errorlevel 1 goto :error
)
call npx tsx src\main.mjs %*
if errorlevel 1 goto :error
echo.
echo Completed.
pause
exit /b 0

:error
echo.
echo Processing failed. Exit code: %ERRORLEVEL%
pause
exit /b %ERRORLEVEL%
