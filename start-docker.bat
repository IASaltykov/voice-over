@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "LOG_DIR=logs"
set "RUN_LOG=%LOG_DIR%\docker-last.log"
set "SERVICE="
set "RUN_CODE=1"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
> "%RUN_LOG%" echo [%DATE% %TIME%] Docker launcher started

where docker >nul 2>nul
if errorlevel 1 (
  call :fail "Docker CLI was not found. Install Docker Desktop and reopen this window."
  goto :end
)
docker info >nul 2>nul
if errorlevel 1 (
  call :fail "Docker Engine is unavailable. Start Docker Desktop and wait for Running status."
  goto :end
)
docker compose version >nul 2>nul
if errorlevel 1 (
  call :fail "Docker Compose V2 is unavailable. Update Docker Desktop."
  goto :end
)
if not exist "docker-compose.yml" if not exist "compose.yaml" if not exist "compose.yml" (
  call :fail "No docker-compose.yml or compose.yaml was found in this project folder."
  goto :end
)

if not exist "input" mkdir "input" >nul 2>nul
if not exist "output" mkdir "output" >nul 2>nul
if not exist "cache" mkdir "cache" >nul 2>nul
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul

for /f "usebackq delims=" %%S in (`docker compose config --services 2^>nul`) do if not defined SERVICE set "SERVICE=%%S"
if not defined SERVICE (
  call :fail "Could not determine a service from the Compose configuration."
  goto :end
)

set "FOUND_INPUT="
for /r "input" %%F in (*.txt *.md *.markdown *.fb2 *.pdf *.zip) do set "FOUND_INPUT=1"
if not defined FOUND_INPUT (
  call :fail "The input folder has no TXT, Markdown, FB2, FB2.ZIP, or PDF documents."
  goto :end
)

set "IMAGE_NAME="
for /f "usebackq delims=" %%I in (`docker compose config --images 2^>nul`) do if not defined IMAGE_NAME set "IMAGE_NAME=%%I"
goto :build

:build
echo Checking Docker image and source changes...
echo Docker will reuse cached layers when the image is current.
docker compose build "%SERVICE%" >> "%RUN_LOG%" 2>&1
if errorlevel 1 (
  type "%RUN_LOG%"
  call :fail "Docker image build failed. See %RUN_LOG%."
  goto :end
)

:run
echo.
echo Starting service "%SERVICE%". Diagnostic log: %RUN_LOG%
echo.
docker compose run --rm "%SERVICE%" %* > "%RUN_LOG%" 2>&1
set "RUN_CODE=%ERRORLEVEL%"
type "%RUN_LOG%"
if not "%RUN_CODE%"=="0" (
  call :fail "Processing failed with exit code %RUN_CODE%. Check %RUN_LOG% and logs\generation.log."
  goto :end
)

echo.
echo Completed. Results are in output. Logs are in %RUN_LOG% and logs\generation.log.
goto :end

:fail
echo.
echo ERROR: %~1
>> "%RUN_LOG%" echo [%DATE% %TIME%] ERROR: %~1
set "RUN_CODE=1"

:end
echo.
pause
exit /b %RUN_CODE%
