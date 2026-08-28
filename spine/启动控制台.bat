@echo off
setlocal
cd /d "%~dp0"
title Ryza Spine Server

set "PYTHON_CMD="
where py >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=py -3"

if not defined PYTHON_CMD (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON_CMD=python"
)

if not defined PYTHON_CMD (
  echo [ERROR] Python 3 was not found.
  echo Install Python, then run this file again.
  pause
  exit /b 1
)

echo Ryza Spine Control Desk
echo URL: http://127.0.0.1:18765/
echo Keep this window open. Press Ctrl+C to stop.
echo.

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://127.0.0.1:18765/'"
%PYTHON_CMD% -m http.server 18765 --bind 127.0.0.1
set "SERVER_EXIT=%errorlevel%"

echo.
echo [ERROR] Server stopped with exit code %SERVER_EXIT%.
echo Port 18765 may already be in use.
pause
exit /b %SERVER_EXIT%
