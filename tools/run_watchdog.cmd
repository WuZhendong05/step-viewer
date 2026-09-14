@echo off
rem ============================================================
rem  CAD viewer watchdog
rem  Invoked by Scheduled Task "CADWatchdog" via tools\run_service.py
rem  (trigger: at user logon + repeat every 2 minutes, interactive session)
rem
rem  Probes both services; after 3 consecutive failures it restarts the
rem  corresponding Scheduled Task (see tools\healthcheck.py).
rem  Runs in the SAME interactive session as the services, so it can never
rem  mistake a logged-off session for a real outage.
rem
rem  Machine-specific settings (Python path) live in the git-ignored
rem  tools\local.env.cmd -- copy local.env.cmd.example and fill it in.
rem ============================================================
setlocal

rem ROOT is derived from this script's own location -- no machine-specific paths here.
set "ROOT=%~dp0.."
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "LOGDIR=%ROOT%\logs"
set "OUTLOG=%LOGDIR%\watchdog.log"
set "TMPOUT=%TEMP%\cadwatch.out"
set "MAXBYTES=5242880"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

call :loadenv
if errorlevel 1 exit /b 2
set "PY=%CAD_PYTHON%"

for %%F in ("%OUTLOG%") do if %%~zF GEQ %MAXBYTES% (
  if exist "%OUTLOG%.1" del /f /q "%OUTLOG%.1"
  move /y "%OUTLOG%" "%OUTLOG%.1" >nul
)

cd /d "%ROOT%" || exit /b 3

"%PY%" "%ROOT%\tools\healthcheck.py" > "%TMPOUT%" 2>&1

rem FAIL present -> append the whole report; otherwise one-line heartbeat
findstr /C:"FAIL" /C:"ERR" "%TMPOUT%" >nul
if errorlevel 1 (
  echo %DATE% %TIME% ok >> "%OUTLOG%"
) else (
  echo. >> "%OUTLOG%"
  echo ---- %DATE% %TIME% ---- >> "%OUTLOG%"
  type "%TMPOUT%" >> "%OUTLOG%"
)
del /f /q "%TMPOUT%" >nul 2>&1
exit /b 0

:loadenv
rem Load machine-specific config; fail loudly rather than silently degrading.
if not exist "%~dp0local.env.cmd" (
  echo [%DATE% %TIME%] FATAL: tools\local.env.cmd not found ^(copy local.env.cmd.example and fill it in^) >> "%OUTLOG%"
  exit /b 1
)
call "%~dp0local.env.cmd" >nul 2>&1
if not defined CAD_PYTHON (
  echo [%DATE% %TIME%] FATAL: CAD_PYTHON not set in tools\local.env.cmd >> "%LOGDIR%\watchdog.log"
  exit /b 1
)
if not exist "%CAD_PYTHON%" (
  echo [%DATE% %TIME%] FATAL: CAD_PYTHON not found: %CAD_PYTHON% >> "%LOGDIR%\watchdog.log"
  exit /b 1
)
exit /b 0
