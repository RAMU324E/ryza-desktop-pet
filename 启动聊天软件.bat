@echo off
setlocal
cd /d "%~dp0"
title Ryza MOKAMOKA Chat Host

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Python virtual environment was not found.
  echo Create .venv and install moka_app\requirements.txt first.
  pause
  exit /b 1
)

echo Ryza MOKAMOKA Chat
echo URL: http://127.0.0.1:18766/
echo Settings: %%APPDATA%%\RyzaPet\settings.json
echo Press Ctrl+C to stop.
echo.

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://127.0.0.1:18766/'"
".venv\Scripts\python.exe" -m ryza_moka
set "SERVER_EXIT=%errorlevel%"

echo.
echo [ERROR] Server stopped with exit code %SERVER_EXIT%.
echo Port 18766 may already be in use.
pause
exit /b %SERVER_EXIT%
