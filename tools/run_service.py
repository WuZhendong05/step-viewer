# -*- coding: utf-8 -*-
"""Windowless launcher for the CAD viewer services (used as the Scheduled Task action).

    pythonw.exe tools\\run_service.py viewer | api | watchdog

Why this exists
---------------
Task Scheduler starts the task action with CreateProcess. If the action is a
*console* image (cmd.exe or python.exe) it gets a REAL, VISIBLE console window
in the interactive session -- and the task setting <Hidden>true</Hidden> only
hides the task from the Task Scheduler UI, it does NOT hide that window.
Closing the window sends CTRL_CLOSE_EVENT and kills the whole process tree with
exit code 0xC000013A (3221225786). That is exactly what happened on 2026-09-10
16:03 and took both services down silently for an hour.

So the task action is pythonw.exe (a GUI-subsystem image: Windows never gives it
a console), and this launcher starts the real work with CREATE_NO_WINDOW. The
existing .cmd files stay the single source of truth for env vars / cwd / log
redirection -- this only removes the window.

The launcher stays alive for the whole service lifetime, so:
  * the Scheduled Task shows "Running" (and Stop-ScheduledTask works),
  * "restart the task if it fails" (999 x 1min) keeps working.
Its own diagnostics go to logs\\launcher_<mode>.log, because pythonw.exe has no
stdout/stderr to write to.
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
LOG_DIR = os.path.join(ROOT, "logs")

MODES = {
    "viewer": "run_viewer.cmd",
    "api": "run_api.cmd",
    "watchdog": "run_watchdog.cmd",
}


def _log(path: str, message: str) -> None:
    """Append a line to logs\\launcher_<mode>.log (pythonw.exe has no console)."""
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def main(argv) -> int:
    if len(argv) < 2 or argv[1] not in MODES:
        print(f"usage: run_service.py [{'|'.join(MODES)}]", file=sys.stderr)
        return 2

    mode = argv[1]
    script = os.path.join(TOOLS, MODES[mode])
    logfile = os.path.join(LOG_DIR, f"launcher_{mode}.log")

    if not os.path.isfile(script):
        _log(logfile, f"FATAL: launcher script not found: {script}")
        return 3

    _log(logfile, f"launching {MODES[mode]} (no console window)")

    # CREATE_NO_WINDOW: the child console process gets no console window at all.
    try:
        proc = subprocess.Popen(  # noqa: S603 - fixed argv, local script
            ["cmd", "/c", script],
            cwd=ROOT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError as exc:
        _log(logfile, f"FATAL: cannot spawn {MODES[mode]}: {exc}")
        return 4

    _log(logfile, f"{MODES[mode]} started, pid={proc.pid}")
    rc = proc.wait()
    _log(logfile, f"{MODES[mode]} exited rc={rc}")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
