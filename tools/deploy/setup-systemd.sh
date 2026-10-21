#!/usr/bin/env bash
# step-viewer: install the two long-running services as systemd units.
#
# This script is idempotent: re-running it rewrites the units and restarts.
#
#   viewer : :3245  Python viewer server (viewer/server_py.server)
#   api    :8420  upload API (serves viewerUrl pointing back at :3245)
#
# On the Windows dev box this role was played by scheduled tasks
# (CADViewer-Logon / CADUploadApi-Logon). Linux uses systemd instead.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/step-viewer}"
CAD_PY="${CAD_PY:-/opt/cad/venv/bin/python}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
API_KEY_FILE="${API_KEY_FILE:-$APP_DIR/secrets/api.key}"
VIEWER_PORT="${VIEWER_PORT:-3245}"
API_PORT="${API_PORT:-8420}"
VIEWER_HOST="${VIEWER_HOST:?VIEWER_HOST must be set (public IP or LAN address)}"
# Hosts the API may FETCH a stepUrl from (comma-separated host suffixes / exact
# hosts / CIDRs). EMPTY = every stepUrl request is rejected with 400: the URL
# upload path is off unless an operator names the file host here. Keep this as
# narrow as the business system's file service allows — it is an SSRF boundary.
URL_ALLOW_HOSTS="${URL_ALLOW_HOSTS:-}"

# Worker counts. The Windows box settled on 4 workers as the sweet spot; the
# Lighthouse instance has 2 vCPU and only ~2 GB RAM, so keep it at 1 to avoid
# OOM-killing the OCCT worker mid-tessellation.
CAD_WORKERS="${CAD_WORKERS:-1}"
PREWARM_WORKERS="${PREWARM_WORKERS:-1}"

install -d "$APP_DIR/secrets"

# ---------------------------------------------------------------- api key ---
if [ ! -s "$API_KEY_FILE" ]; then
  # 32 hex chars, matching the key shape the dev box used.
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$API_KEY_FILE"
  chmod 600 "$API_KEY_FILE"
  echo "generated new API key -> $API_KEY_FILE"
else
  chmod 600 "$API_KEY_FILE"
  echo "reusing existing API key -> $API_KEY_FILE"
fi

# ----------------------------------------------------------------- viewer ---
cat > /etc/systemd/system/step-viewer.service <<EOF
[Unit]
Description=CAD Viewer (step-viewer frontend + Python render backend)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR/viewer
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONUTF8=1
Environment=LANG=C.UTF-8
Environment=VIEWER_CAD_WORKERS=$CAD_WORKERS
Environment=VIEWER_TIMING_LOG=1
Environment=VIEWER_DISABLE_NATIVE_SAVE_DIALOG=1
ExecStart=$CAD_PY -m server_py.server --host 0.0.0.0 --port $VIEWER_PORT
Restart=always
RestartSec=5
StandardOutput=append:$APP_DIR/logs/viewer.log
StandardError=append:$APP_DIR/logs/viewer.err.log

[Install]
WantedBy=multi-user.target
EOF

# -------------------------------------------------------------------- api ---
cat > /etc/systemd/system/step-upload-api.service <<EOF
[Unit]
Description=CAD Viewer upload API
After=network-online.target step-viewer.service
Wants=network-online.target
Requires=step-viewer.service

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR/viewer
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONUTF8=1
Environment=LANG=C.UTF-8
# ⚠️ VIEWER_PREWARM_WORKERS 是 api_server 读的（api_server.py:1006），写进 viewer 单元是死配置
Environment=VIEWER_PREWARM_WORKERS=$PREWARM_WORKERS
ExecStart=$CAD_PY -m server_py.api_server --host 0.0.0.0 --port $API_PORT --viewer-host $VIEWER_HOST --viewer-port $VIEWER_PORT --api-key-file $API_KEY_FILE --url-allow-hosts "$URL_ALLOW_HOSTS"
Restart=always
RestartSec=5
StandardOutput=append:$APP_DIR/logs/api.log
StandardError=append:$APP_DIR/logs/api.err.log

[Install]
WantedBy=multi-user.target
EOF

install -d "$APP_DIR/logs"

systemctl daemon-reload
systemctl enable step-viewer.service step-upload-api.service
systemctl restart step-viewer.service
systemctl restart step-upload-api.service

sleep 3
systemctl --no-pager --full status step-viewer.service | head -12
echo "----------------------------------------------------------------"
systemctl --no-pager --full status step-upload-api.service | head -12
