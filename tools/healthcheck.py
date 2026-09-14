# -*- coding: utf-8 -*-
"""Service watchdog: probe both CAD viewer services and restart them when they
fail N consecutive checks. Run manually or from Task Scheduler.

    python tools/healthcheck.py                 # one check cycle
    python tools/healthcheck.py --loop 60       # check every 60s

Restart carrier (env VIEWER_CARRIER, default "task"):
  * task    - Scheduled Task "CADViewer-Logon" / "CADUploadApi-Logon"
              (interactive user session; see docs/业务系统对接使用文档.md §9)
  * service - legacy NSSM Windows services CADViewer / CADUploadApi
"""
import argparse
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = os.path.join(ROOT, "logs", "healthcheck_state.txt")

NSSM = r"D:\nssm\nssm-2.24\win64\nssm.exe"
CARRIER = os.environ.get("VIEWER_CARRIER", "task").strip().lower()
TASK_FOR = {"CADViewer": "CADViewer-Logon", "CADUploadApi": "CADUploadApi-Logon"}
PORT_FOR = {"CADViewer": 3245, "CADUploadApi": 8420}
CHECKS = [
    ("CADViewer", "http://127.0.0.1:3245/__cad/server"),
    ("CADUploadApi", "http://127.0.0.1:8420/healthz"),
]
FAIL_THRESHOLD = 3


def _probe(url: str, timeout: float = 10.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= resp.status < 500  # a JSON error is still "service alive"
    except Exception:  # noqa: BLE001
        return False


def _read_state() -> dict:
    state = {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            for line in handle:
                name, _, n = line.strip().partition("=")
                if name and n.isdigit():
                    state[name] = int(n)
    except OSError:
        pass
    return state


def _write_state(state: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as handle:
            for name, n in state.items():
                handle.write(f"{name}={n}\n")
    except OSError:
        pass


def _run(cmd, timeout=30.0):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        print(f"   ({cmd[0]} failed: {exc})", file=sys.stderr)
        return None


def _port_owner(port: int):
    """PID currently LISTENING on `port`, or None."""
    res = _run(["netstat", "-ano", "-p", "tcp"], timeout=20.0)
    if not res or not res.stdout:
        return None
    for line in res.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP" and "LISTENING" in line:
            if parts[1].rsplit(":", 1)[-1] == str(port):
                try:
                    return int(parts[-1])
                except ValueError:
                    pass
    return None


def _restart_task(service: str) -> None:
    """End the scheduled task (killing any lingering listener), then run it again."""
    name = TASK_FOR[service]
    print(f"!! restarting scheduled task {name}", file=sys.stderr)
    _run(["schtasks", "/End", "/TN", name])
    time.sleep(3)
    pid = _port_owner(PORT_FOR[service])
    if pid:
        print(f"   killing lingering listener pid={pid}", file=sys.stderr)
        _run(["taskkill", "/F", "/PID", str(pid)])
        time.sleep(2)
    _run(["schtasks", "/Run", "/TN", name])


def _restart_service(service: str) -> None:
    if not os.path.isfile(NSSM):
        print(f"nssm not found at {NSSM}; cannot auto-restart {service}", file=sys.stderr)
        return
    print(f"!! restarting {service} via nssm", file=sys.stderr)
    _run([NSSM, "restart", service])


def _restart(service: str) -> None:
    if CARRIER == "service":
        _restart_service(service)
    else:
        _restart_task(service)


def run_cycle() -> dict:
    state = _read_state()
    for service, url in CHECKS:
        alive = _probe(url)
        streak = 0 if alive else state.get(service, 0) + 1
        state[service] = streak
        if alive:
            print(f"{service}: OK")
        else:
            print(f"{service}: FAIL (streak {streak}/{FAIL_THRESHOLD})")
            if streak >= FAIL_THRESHOLD:
                _restart(service)
                state[service] = 0
    _write_state(state)
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description="CAD viewer services watchdog")
    parser.add_argument("--loop", type=int, default=0, help="check every N seconds (0 = once)")
    args = parser.parse_args(argv)
    while True:
        run_cycle()
        if not args.loop:
            return 0
        time.sleep(args.loop)


if __name__ == "__main__":
    sys.exit(main())
