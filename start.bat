@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  IELTS app - one-click start (with Kokoro TTS)
echo ============================================
echo.

call :ensure_kokoro
if errorlevel 1 goto appexit
call :ensure_pg
if errorlevel 1 goto appexit
call :ensure_app
if errorlevel 1 goto appexit

echo.
echo Opening http://localhost:3000 ...
start "" http://localhost:3000
echo.
echo Services run in minimized windows:
echo   IELTS-Kokoro-TTS  /  IELTS-Postgres  /  IELTS-NextJS
echo Close those windows to stop them.
echo You can close THIS window - the services keep running.
echo.
endlocal
exit /b 0

rem ---- ensure local Kokoro TTS engine -------------------------------------
:ensure_kokoro
netstat -ano | findstr ":8880" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo [TTS] Kokoro already on :8880 - skip.
  exit /b 0
)
echo [TTS] Starting local Kokoro-FastAPI on :8880 ...
start "IELTS-Kokoro-TTS" /min cmd /c "node scripts/start-kokoro.mjs"
echo [TTS] Waiting for :8880 ^(first load ~15s^) ...
set /a tries=0
:waitkokoro
ping -n 2 127.0.0.1 >nul 2>&1
netstat -ano | findstr ":8880" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo [TTS] Ready.
  exit /b 0
)
set /a tries+=1
if %tries% lss 90 goto waitkokoro
echo [TTS] TIMEOUT. Check: node scripts/start-kokoro.mjs
exit /b 1

rem ---- ensure database -----------------------------------------------------
:ensure_pg
netstat -ano | findstr ":5432" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo [DB]  PostgreSQL already on :5432 - skip.
  exit /b 0
)
echo [DB]  Starting embedded PostgreSQL ...
start "IELTS-Postgres" /min cmd /c "node scripts/start-postgres.mjs"
echo [DB]  Waiting for :5432 ...
set /a tries=0
:waitdb
ping -n 2 127.0.0.1 >nul 2>&1
netstat -ano | findstr ":5432" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo [DB]  Ready.
  exit /b 0
)
set /a tries+=1
if %tries% lss 60 goto waitdb
echo [DB]  TIMEOUT. Check: node scripts/start-postgres.mjs
exit /b 1

rem ---- ensure app ----------------------------------------------------------
:ensure_app
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo [APP] Already on :3000 - skip.
  exit /b 0
)
echo [APP] Starting Next.js dev server on :3000 ...
start "IELTS-NextJS" /min cmd /c "npm run dev -- -p 3000"
echo [APP] Waiting for :3000 ...
set /a tries=0
:waitapp
ping -n 2 127.0.0.1 >nul 2>&1
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
  echo [APP] Ready.
  exit /b 0
)
set /a tries+=1
if %tries% lss 90 goto waitapp
echo [APP] TIMEOUT. Check: npm run dev
exit /b 1
