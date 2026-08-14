@echo off
pushd "%~dp0"
title DM local server
echo ==================================================
echo  DM planning summary - local server
echo  Open: http://localhost:8777/index.html
echo  Close this window to STOP the server.
echo ==================================================
start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:8777/index.html"
python -m http.server 8777
popd
