@echo off
echo === Audio Forge Stream Deck Plugin - Version Updater ===
echo.
echo Enter the version  ^(e.g. 1.2.3 or 1.2.3.45^)
echo  - package.json and package-lock.json: 1.2.3
echo  - manifest.json will be set to:      1.2.3.0  ^(or 1.2.3.45 if build specified^)
echo.
set /p VERSION="New version: "

if "%VERSION%"=="" (
    echo No version entered. Aborting.
    pause
    exit /b 1
)

node set-version.cjs "%VERSION%"

if %ERRORLEVEL% neq 0 (
    echo ERROR: version update failed.
    pause
    exit /b 1
)

echo.
echo Done!
pause
