@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

where docker >nul 2>nul || (echo Docker CLI was not found.& pause & exit /b 1)
docker info >nul 2>nul || (echo Docker Engine is unavailable.& pause & exit /b 1)
docker compose version >nul 2>nul || (echo Docker Compose V2 is unavailable.& pause & exit /b 1)

echo Stopping containers belonging to this Compose project only...
docker compose down --remove-orphans
set "RUN_CODE=%ERRORLEVEL%"
if not "%RUN_CODE%"=="0" echo Could not stop the Compose project.
if "%RUN_CODE%"=="0" echo Project containers stopped.
pause
exit /b %RUN_CODE%
