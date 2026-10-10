@echo off
setlocal
title Wealth Ledger
cd /d "%~dp0"

rem Double-click this file to open the ledger. It starts the server if nothing is
rem serving the port yet, then hands the address to your browser. Nothing here
rem installs anything beyond the two packages the app already lists, and nothing
rem here touches the data file except by running the app.

set "PORTNO=3000"
if not "%PORT%"=="" set "PORTNO=%PORT%"
set "URL=http://localhost:%PORTNO%"
set "HAVE_CURL=0"
where curl.exe >nul 2>nul
if not errorlevel 1 set "HAVE_CURL=1"

echo   Wealth Ledger
echo   =============
echo.

where node.exe >nul 2>nul
if errorlevel 1 goto :no_node

if exist "server.js" goto :deps
goto :no_folder

:deps
if exist "node_modules\express\package.json" goto :ensure
where npm.cmd >nul 2>nul
if errorlevel 1 goto :no_npm
echo   First run: fetching the two packages the app needs.
echo   This needs the internet once and can take a minute.
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :no_install
echo.

:ensure
if "%HAVE_CURL%"=="0" goto :blind_start
call :probe
if not errorlevel 1 goto :open

echo   Starting the ledger server in its own window...
start "Wealth Ledger - leave this open" /min cmd /c "node server.js"

rem Boot pulls exchange rates before the server listens, so a slow feed is not a failure.
set "TRIES=0"
:wait
set /a TRIES+=1
ping -n 2 127.0.0.1 >nul
call :probe
if not errorlevel 1 goto :open
if %TRIES% LSS 40 goto :wait
goto :stalled

:blind_start
rem Windows without curl.exe: start the server, wait for it, and hope for the best.
echo   Starting the ledger server in its own window...
start "Wealth Ledger - leave this open" /min cmd /c "node server.js"
ping -n 8 127.0.0.1 >nul
goto :open

:open
echo   Opening %URL% in your browser...
start "" "%URL%"
echo.
echo   The ledger is open in a browser tab.
echo.
echo   The small minimized window titled "Wealth Ledger" is the server. Leave it
echo   alone while you work, and close that window to stop the app.
echo   This launcher window can be closed at any time.
echo.
ping -n 12 127.0.0.1 >nul
exit /b 0

:probe
curl.exe -s -o nul -m 2 "%URL%/" >nul 2>nul
exit /b %errorlevel%

:no_node
echo   Node.js is not on this computer, so the ledger cannot start.
echo   Install the LTS build from https://nodejs.org, then double-click this file again.
echo.
pause
exit /b 1

:no_npm
echo   Node.js is here but npm is not, so the first-run install cannot happen.
echo   Reinstall Node.js from https://nodejs.org - npm comes with it.
echo.
pause
exit /b 1

:no_folder
echo   server.js is missing next to this file.
echo   Unzip the whole folder and double-click the copy inside it, not a loose file.
echo.
pause
exit /b 1

:no_install
echo   The package install failed, so the server cannot start.
echo   Check the internet connection and try again, or run:  npm install
echo.
pause
exit /b 1

:stalled
echo   The ledger did not answer on port %PORTNO% within about 40 seconds.
echo   Look at the "Wealth Ledger" window - it prints why. A damaged data file and a
echo   missing package both say so there, and the app refuses to overwrite a file it
echo   cannot read.
echo.
pause
exit /b 1
