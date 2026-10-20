@echo off
setlocal
cd /d "%~dp0"
netstat -ano | findstr /C:"127.0.0.1:4177" >nul
if errorlevel 1 (
  start "Only Us Local Service" /min cmd /c "cd /d ""%~dp0"" && node server.js"
  timeout /t 2 /nobreak >nul
)
start "" "http://127.0.0.1:4177"
endlocal
