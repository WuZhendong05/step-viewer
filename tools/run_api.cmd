@echo off
rem ============================================================
rem  CADUploadApi launcher (port 8420)
rem  Invoked by Scheduled Task "CADUploadApi-Logon" via tools\run_service.py
rem  (trigger: at user logon + 30s delay, interactive session)
rem
rem  Equivalent of the old NSSM service:
rem    Application / AppParameters / AppDirectory /
rem    AppEnvironmentExtra / AppStdout / AppStderr / log rotation
rem
rem  Machine-specific settings (Python path, VIEWER_HOST) live in the
rem  git-ignored tools\local.env.cmd -- copy local.env.cmd.example and fill it in.
rem ============================================================
setlocal

rem ROOT is derived from this script's own location -- no machine-specific paths here.
set "ROOT=%~dp0.."
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "LOGDIR=%ROOT%\logs"
set "OUTLOG=%LOGDIR%\api.log"
set "ERRLOG=%LOGDIR%\api.err.log"
set "MAXBYTES=10485760"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

call :loadenv
if errorlevel 1 exit /b 2
set "PY=%CAD_PYTHON%"
rem Host reported back to callers as viewerUrl; LAN clients need the machine IP.
if not defined VIEWER_HOST set "VIEWER_HOST=127.0.0.1"
rem Hosts the API may FETCH a stepUrl from (comma-separated host suffixes / exact
rem hosts / CIDRs). Empty = every stepUrl request is rejected with 400; the URL
rem upload path stays off until an operator names the file host here. Override in
rem tools\local.env.cmd when the business system moves to another file service.
if not defined VIEWER_URL_ALLOW_HOSTS set "VIEWER_URL_ALLOW_HOSTS=*.aliyuncs.com"

rem --- project-wide env vars (mirror of NSSM AppEnvironmentExtra) ---
set "PYTHONUNBUFFERED=1"
set "VIEWER_PREWARM_WORKERS=4"
set "VIEWER_TIMING_LOG=1"

rem --- rotate logs at startup ---
call :rotate "%OUTLOG%"
call :rotate "%ERRLOG%"

cd /d "%ROOT%\viewer" || (
  echo [%DATE% %TIME%] FATAL: cannot cd to %ROOT%\viewer >> "%ERRLOG%"
  exit /b 3
)

echo. >> "%OUTLOG%"
echo ============================================================ >> "%OUTLOG%"
echo [%DATE% %TIME%] CADUploadApi starting (interactive session) on 0.0.0.0:8420 >> "%OUTLOG%"

"%PY%" -u -m server_py.api_server --port 8420 --host 0.0.0.0 --viewer-host "%VIEWER_HOST%" --viewer-port 3245 --api-key-file "%ROOT%\secrets\api.key" --url-allow-hosts "%VIEWER_URL_ALLOW_HOSTS%" >> "%OUTLOG%" 2>> "%ERRLOG%"
set "RC=%ERRORLEVEL%"

echo [%DATE% %TIME%] CADUploadApi exited rc=%RC% >> "%OUTLOG%"
exit /b %RC%

:loadenv
rem Load machine-specific config; fail loudly rather than silently degrading.
if not exist "%~dp0local.env.cmd" (
  echo [%DATE% %TIME%] FATAL: tools\local.env.cmd not found ^(copy local.env.cmd.example and fill it in^) >> "%ERRLOG%"
  exit /b 1
)
call "%~dp0local.env.cmd" >nul 2>&1
if not defined CAD_PYTHON (
  echo [%DATE% %TIME%] FATAL: CAD_PYTHON not set in tools\local.env.cmd >> "%ERRLOG%"
  exit /b 1
)
if not exist "%CAD_PYTHON%" (
  echo [%DATE% %TIME%] FATAL: CAD_PYTHON not found: %CAD_PYTHON% >> "%ERRLOG%"
  exit /b 1
)
exit /b 0

:rotate
if not exist "%~1" exit /b 0
for %%F in ("%~1") do if %%~zF GEQ %MAXBYTES% (
  if exist "%~1.1" del /f /q "%~1.1"
  move /y "%~1" "%~1.1" >nul
)
exit /b 0
