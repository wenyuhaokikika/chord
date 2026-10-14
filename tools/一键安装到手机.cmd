@echo off
rem Double-clickable wrapper. Keep this file ASCII-only: cmd.exe reads .cmd
rem files in the system codepage, so non-ASCII text here would break parsing.
cd /d "%~dp0.."
python tools\install_to_phone.py %*
echo.
pause
