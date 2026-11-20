@echo off
rem Quick launcher for MiscJar GUI (double-click to start the 440x600 window)
setlocal
cd /d "%~dp0gui"

rem First run: npm may block electron/sqlite3 install scripts, so install then rebuild
if not exist "node_modules\electron\dist\electron.exe" (
    echo First run: installing dependencies, please wait a few minutes...
    call npm install --no-audit --no-fund
    call npm rebuild electron sqlite3
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron binary is missing. Try manually: cd gui ^&^& npm install
    pause
    exit /b 1
)

rem 随包资源 (codec.js / zipentry.js / 插画) 从仓库根复制进 gui/
call node prepare-assets.js

start "" /wait "node_modules\electron\dist\electron.exe" .
endlocal
