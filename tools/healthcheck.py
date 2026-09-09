# -*- coding: utf-8 -*-
"""Service watchdog: probe both CAD viewer services and restart them via NSSM when
they fail N consecutive checks. Run manually or from Task Scheduler.

    python tools/healthcheck.py                 # one check cycle
    python tools/healthcheck.py --loop 60       # check every 60s
"""
import argparse
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = os.path.join(ROOT, "logs", "healthcheck_state.txt")

NSSM = r"D:\nssm\nssm-2.24\win64\nssm.exe"
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


def _restart(service: str) -> None:
    if not os.path.isfile(NSSM):
        print(f"nssm not found at {NSSM}; cannot auto-restart {service}", file=sys.stderr)
        return
    exe = os.path.basename(NSSM)
    print(f"!! restarting {service} via nssm", file=sys.stderr)
    os.system(f'"{NSSM}" restart {service} >nul 2>&1')  # noqa: S605 — fixed args
    print(f"(nssm={exe})", file=sys.stderr)


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
