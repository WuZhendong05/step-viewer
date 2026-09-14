@echo off
rem ============================================================
rem  CADViewer launcher (port 3245)
rem  Invoked by Scheduled Task "CADViewer-Logon" via tools\run_service.py
rem  (trigger: at user logon, interactive session -> NOT session 0)
rem
rem  Equivalent of the old NSSM service:
rem    Application / AppParameters / AppDirectory /
rem    AppEnvironmentExtra / AppStdout / AppStderr / log rotation
rem
rem  Machine-specific settings (Python paths) live in the git-ignored
rem  tools\local.env.cmd -- copy local.env.cmd.example and fill it in.
rem ============================================================
setlocal

rem ROOT is derived from this script's own location -- no machine-specific paths here.
set "ROOT=%~dp0.."
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "LOGDIR=%ROOT%\logs"
set "OUTLOG=%LOGDIR%\viewer.log"
set "ERRLOG=%LOGDIR%\viewer.err.log"
set "MAXBYTES=10485760"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

call :loadenv
if errorlevel 1 exit /b 2
set "PY=%CAD_PYTHON%"

rem --- project-wide env vars (mirror of NSSM AppEnvironmentExtra) ---
rem VIEWER_PYTHONOCC_PYTHON comes from local.env.cmd; it is REQUIRED for
rem feature-face highlighting (must be an OCC namespace, e.g. pythonocc).
set "VIEWER_DISABLE_NATIVE_SAVE_DIALOG=1"
set "PYTHONUNBUFFERED=1"
set "VIEWER_CAD_WORKERS=4"
set "VIEWER_TIMING_LOG=1"

rem --- rotate logs at startup (NSSM used online rotation at 10MB) ---
call :rotate "%OUTLOG%"
call :rotate "%ERRLOG%"

cd /d "%ROOT%\viewer" || (
  echo [%DATE% %TIME%] FATAL: cannot cd to %ROOT%\viewer >> "%ERRLOG%"
  exit /b 3
)

echo. >> "%OUTLOG%"
echo ============================================================ >> "%OUTLOG%"
echo [%DATE% %TIME%] CADViewer starting (interactive session) on 0.0.0.0:3245 >> "%OUTLOG%"

"%PY%" -u -m server_py.server --host 0.0.0.0 --port 3245 >> "%OUTLOG%" 2>> "%ERRLOG%"
set "RC=%ERRORLEVEL%"

echo [%DATE% %TIME%] CADViewer exited rc=%RC% >> "%OUTLOG%"
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
