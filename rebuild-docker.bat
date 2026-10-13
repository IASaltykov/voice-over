@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

where docker >nul 2>nul || (echo Docker CLI was not found.& pause & exit /b 1)
docker info >nul 2>nul || (echo Docker Engine is unavailable. Start Docker Desktop.& pause & exit /b 1)
docker compose version >nul 2>nul || (echo Docker Compose V2 is unavailable.& pause & exit /b 1)

set "SERVICE="
for /f "usebackq delims=" %%S in (`docker compose config --services 2^>nul`) do if not defined SERVICE set "SERVICE=%%S"
if not defined SERVICE (echo Could not determine a Compose service.& pause & exit /b 1)

if not exist "logs" mkdir "logs" >nul 2>nul
echo Rebuilding service "%SERVICE%" without Docker cache...
docker compose build --no-cache "%SERVICE%" > "logs\docker-rebuild-last.log" 2>&1
set "RUN_CODE=%ERRORLEVEL%"
type "logs\docker-rebuild-last.log"
if not "%RUN_CODE%"=="0" echo Build failed. Log: logs\docker-rebuild-last.log
if "%RUN_CODE%"=="0" echo Build completed.
pause
exit /b %RUN_CODE%
