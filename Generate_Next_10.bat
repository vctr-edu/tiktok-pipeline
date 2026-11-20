@echo off
setlocal
title Broken Reflection - Generate Next 10 Videos
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0generate_next_10.py"
) else (
  python "%~dp0generate_next_10.py"
)

echo.
if not "%errorlevel%"=="0" echo The generator stopped with an error. Review the message above.
pause
