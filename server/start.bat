@echo off
setlocal enabledelayedexpansion
title WebBridge Server
echo ========================================
echo   WebBridge - AI File Connector
echo ========================================
cd /d "%~dp0"

echo.
echo [1/4] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js not found in PATH!
    echo Download from https://nodejs.org/
    pause
    exit /b 1
)
node --version

echo.
echo [2/4] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo [3/4] Determining workspace...
set "WORKSPACE=%~1"

if "%WORKSPACE%"=="" (
    REM Coba deteksi folder yang terbuka di VS Code via `code --status`
    where code >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        for /f "tokens=*" %%i in ('code --status 2^>nul ^| findstr /i "workspace" ^| findstr /i "file:///"') do (
            set "LINE=%%i"
            REM Ekstrak path dari baris (format bisa bervariasi)
            REM Ini heuristik sederhana; jika gagal, pengguna tetap bisa set manual
            for /f "tokens=2 delims= " %%p in ("!LINE!") do (
                set "CANDIDATE=%%p"
                set "CANDIDATE=!CANDIDATE:file:///=!"
                set "CANDIDATE=!CANDIDATE:/=\!"
                if exist "!CANDIDATE!\" (
                    set "WORKSPACE=!CANDIDATE!"
                    goto :workspace_found
                )
            )
        )
    )
)

:workspace_found
if "%WORKSPACE%"=="" (
    echo     No workspace argument and auto-detect failed.
    echo     Set via extension popup after starting, or restart with:
    echo     start.bat "C:\path\to\your\project"
    echo.
) else (
    echo     Workspace: %WORKSPACE%
)

echo.
echo [4/4] Starting server...
echo     Press Ctrl+C to stop.
echo ========================================

if "%WORKSPACE%"=="" (
    node server.js
) else (
    node server.js "%WORKSPACE%"
)

echo.
echo Server stopped.
pause
endlocal