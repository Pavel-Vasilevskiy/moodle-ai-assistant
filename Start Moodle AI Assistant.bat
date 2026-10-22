@echo off
set "LAUNCHER_PY=%~dp0backend\.venv\Scripts\pythonw.exe"
if not exist "%LAUNCHER_PY%" set "LAUNCHER_PY=%~dp0backend\.venv\Scripts\python.exe"
if not exist "%LAUNCHER_PY%" (
    echo The backend virtual environment was not found.
    echo Follow the installation steps in README.md first.
    pause
    exit /b 1
)
start "Moodle AI Assistant" "%LAUNCHER_PY%" "%~dp0backend\launcher.py"
