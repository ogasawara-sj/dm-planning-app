@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DM planning summary - local server
echo ============================================
echo  DM kikaku summary : starting local server
echo  URL : http://localhost:8777/index.html
echo  (Close this window to STOP the server)
echo ============================================
rem サーバーをこのウィンドウで起動する前に、少し待ってからブラウザを開く
start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:8777/index.html"
python -m http.server 8777
pause
