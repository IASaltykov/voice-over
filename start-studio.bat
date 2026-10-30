@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if not exist "input" mkdir "input" >nul 2>nul
if not exist "output" mkdir "output" >nul 2>nul
if not exist "cache" mkdir "cache" >nul 2>nul
if not exist "data" mkdir "data" >nul 2>nul
if not exist "logs" mkdir "logs" >nul 2>nul

where docker >nul 2>nul || (echo Docker CLI was not found. Install Docker Desktop.& pause & exit /b 1)
docker info >nul 2>nul || (echo Docker Engine is unavailable. Start Docker Desktop.& pause & exit /b 1)
docker compose version >nul 2>nul || (echo Docker Compose V2 is unavailable. Update Docker Desktop.& pause & exit /b 1)

echo Building Article Studio if needed...
docker compose build article-studio
if errorlevel 1 (echo Docker build failed.& pause & exit /b 1)

docker compose run --rm article-studio %*
set "RUN_CODE=%ERRORLEVEL%"
if not "%RUN_CODE%"=="0" echo Article Studio ended with exit code %RUN_CODE%.
pause
exit /b %RUN_CODE%
