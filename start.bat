@echo off
setlocal
cd /d "%~dp0"
set "PYTHON_CMD=python"
where %PYTHON_CMD% >nul 2>nul
if errorlevel 1 (
    echo Python не найден в PATH.
    pause
    exit /b 3
)
%PYTHON_CMD% main.py %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Генерация завершилась с ошибкой. Код: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
