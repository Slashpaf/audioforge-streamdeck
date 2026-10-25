@echo off
setlocal

echo Installing locked dependencies...
call npm ci
if errorlevel 1 exit /b 1

echo Building Audio Forge for Stream Deck...
call npm run typecheck
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1

call node scripts/verify-manifest.mjs
if errorlevel 1 exit /b 1

echo Build complete: com.slashpaf.audioforge.sdPlugin\bin\plugin.js

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-plugin.ps1
if errorlevel 1 exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-elgato.ps1
if errorlevel 1 exit /b 1
