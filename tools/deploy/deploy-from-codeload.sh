#!/usr/bin/env bash
# =============================================================================
# step-viewer 一键部署（阿里云 ECS / Ubuntu 20.04、22.04、24.04 / x86_64）
#
#   用法（服务器上，任意目录）：
#       sudo bash deploy-from-codeload.sh
#       sudo bash deploy-from-codeload.sh --selftest          # 部署完再做一次端到端自检
#       sudo bash deploy-from-codeload.sh --ref <tag|sha>     # 拉指定版本（默认 main）
#       sudo bash deploy-from-codeload.sh --skip-deps         # 跳过 apt/python/node 安装
#       sudo bash deploy-from-codeload.sh --code-only         # 只更新代码，不装依赖不构建
#
#   幂等：重复执行 = 更新。uploads/ logs/ secrets/ 不会被覆盖；systemd 单元每次重写并重启。
#
#   设计要点（踩过的坑，别改）：
#     * Python 必须 3.11：cadgen 要求 >=3.11，OCP 7.9.3.1 的 wheel 是 cp310..cp314，
#       Ubuntu 20.04 自带 3.8 → 装不了。走 deadsnakes PPA。
#     * OCP 用 cadquery-ocp-novtk（无 VTK，天然 headless），不要装 pythonocc-core：
#       两者都带 OCCT 原生库，同环境必冲突。
#     * OCPSVG / ocp_gordon 必须钉版本（新版 API 不兼容）。
#     * 前端 vite 7 要求 Node >= 20.19 或 >= 22.12 → 装 22.22.2（与本机一致）。
#       用阿里云 nodejs 镜像下载官方 tarball，不依赖 NodeSource 外网。
#     * 小内存机器（2GB）必须 swap + worker=1，否则 OCP 出图时被 OOM killer 杀。
#     * 代码用 codeload tar.gz 拉取，不用 git clone：不需要 .git，也不需要 git 凭据。
# =============================================================================
set -euo pipefail

REPO="${REPO:-WuZhendong05/step-viewer}"
REF="${REF:-main}"
APP_DIR="${APP_DIR:-/opt/step-viewer}"
VENV_DIR="${VENV_DIR:-/opt/venvs/cadgen}"
NODE_VERSION="${NODE_VERSION:-22.22.2}"
NODE_PREFIX="${NODE_PREFIX:-/usr/local/lib/nodejs}"
PYPI_INDEX="${PYPI_INDEX:-https://mirrors.aliyun.com/pypi/simple/}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
VIEWER_PORT="${VIEWER_PORT:-3245}"
API_PORT="${API_PORT:-8420}"
URL_ALLOW_HOSTS="${URL_ALLOW_HOSTS:-*.aliyuncs.com}"

DO_SELFTEST=0
SKIP_DEPS=0
CODE_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --selftest)  DO_SELFTEST=1 ;;
    --skip-deps) SKIP_DEPS=1 ;;
    --code-only) CODE_ONLY=1 ;;
    --ref=*)     REF="${1#*=}" ;;
    --ref)       shift; REF="${1:-main}" ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- 日志小工具 ---
C_RESET=$'\033[0m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_STEP=$'\033[36m'
ts() { date '+%H:%M:%S'; }
step() { echo; echo "${C_STEP}==== [$1] $2 ====${C_RESET}"; }
ok()   { echo "${C_OK}  ✓ $*${C_RESET}"; }
warn() { echo "${C_WARN}  ! $*${C_RESET}"; }
die()  { echo "${C_ERR}  ✗ $*${C_RESET}" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"
[ "$(uname -m)" = "x86_64" ] || die "当前架构 $(uname -m) 没有 OCP 预编译 wheel，需 aarch64/x86_64 另行评估"

# 中文文件名是硬需求（特征名、零件名都含中文）
export LANG="${LANG:-C.UTF-8}"
export LC_ALL="${LC_ALL:-C.UTF-8}"
export PYTHONUTF8=1
export DEBIAN_FRONTEND=noninteractive

MEM_KB=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
CPU_N=$(nproc)
if [ -z "${CAD_WORKERS:-}" ]; then
  if   [ "$MEM_KB" -lt 3000000 ]; then CAD_WORKERS=1
  elif [ "$MEM_KB" -lt 6000000 ]; then CAD_WORKERS=2
  else CAD_WORKERS=4; fi
fi
PREWARM_WORKERS="${PREWARM_WORKERS:-$CAD_WORKERS}"

# viewerUrl 里回报给业务系统的主机名：内网部署用本机主 IP
if [ -z "${VIEWER_HOST:-}" ]; then
  VIEWER_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
[ -n "$VIEWER_HOST" ] || die "无法自动识别本机 IP，请显式指定：VIEWER_HOST=<ip> sudo -E bash $0"

cat <<EOF
${C_STEP}step-viewer 部署参数${C_RESET}
  repo            : $REPO@$REF
  app dir         : $APP_DIR
  cad venv        : $VENV_DIR
  viewer / api    : $VIEWER_HOST:$VIEWER_PORT / :$API_PORT
  viewerUrl host  : $VIEWER_HOST   （业务系统必须能访问到这个地址）
  cpu / mem       : ${CPU_N} core / $((MEM_KB/1024)) MB
  cad workers     : $CAD_WORKERS  (prewarm $PREWARM_WORKERS)
  stepUrl 白名单  : ${URL_ALLOW_HOSTS:-<空=禁用>}
EOF

# ------------------------------------------------------------------- 1. 系统 ---
if [ "$SKIP_DEPS" -eq 0 ]; then
  step 1/8 "系统依赖（apt）"
  apt-get update -y
  apt-get install -y --no-install-recommends \
    curl ca-certificates xz-utils tar rsync openssl \
    software-properties-common gnupg \
    libgl1 libglu1-mesa libxrender1 libxext6 libxkbcommon0 \
    libgomp1 libgfortran5 >/dev/null
  ok "apt 依赖就绪"

  # 2GB 机器：不加 swap，OCP 峰值必然触发 OOM killer
  if [ "$MEM_KB" -lt 3200000 ] && ! swapon --show | grep -q '/swapfile'; then
    step 2/8 "配置 2GB swap（内存 $((MEM_KB/1024)) MB）"
    if fallocate -l 2G /swapfile 2>/dev/null; then :; else dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; fi
    chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap 已启用"
  fi
else
  warn "跳过系统依赖安装（--skip-deps）"
fi

# ---------------------------------------------------------------- 3. Python ---
if [ "$SKIP_DEPS" -eq 0 ]; then
  step 3/8 "Python 3.11"
  if ! command -v python3.11 >/dev/null 2>&1; then
    . /etc/os-release
    if [ "${VERSION_ID:-}" = "20.04" ] || [ "${VERSION_ID:-}" = "22.04" ] || [ "${VERSION_ID:-}" = "24.04" ]; then
      add-apt-repository -y ppa:deadsnakes/ppa
      apt-get update -y
    else
      warn "未预期的发行版 ${PRETTY_NAME:-?}，仍尝试 deadsnakes"
      add-apt-repository -y ppa:deadsnakes/ppa || true
      apt-get update -y || true
    fi
    apt-get install -y python3.11 python3.11-venv python3.11-dev \
      || die "python3.11 安装失败：检查外网是否可达 ppa.launchpadcontent.net（或手工装 3.11 后重跑 --skip-deps）"
  fi
  ok "$(python3.11 -V 2>&1)"

  step 4/8 "Node.js $NODE_VERSION（前端构建 + cadgen 的 JS 几何构建器都要）"
  need_node=1
  if command -v node >/dev/null 2>&1; then
    cv=$(node -v | sed 's/^v//'); maj=${cv%%.*}; rest=${cv#*.}; min=${rest%%.*}
    if { [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 12 ]; }; } \
       || { [ "$maj" -eq 21 ] || { [ "$maj" -eq 20 ] && [ "$min" -ge 19 ]; }; }; then
      need_node=0; ok "已有 node $(node -v)，满足 vite 7 要求"
    else
      warn "已有 node $(node -v) 太旧（vite 7 需 >=20.19 / >=22.12），安装 $NODE_VERSION"
    fi
  fi
  if [ "$need_node" -eq 1 ]; then
    tmpn=$(mktemp -d)
    url="https://mirrors.aliyun.com/nodejs-release/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
    curl -fL --retry 3 --connect-timeout 20 -o "$tmpn/node.tar.xz" "$url" || die "Node 下载失败：$url"
    mkdir -p "$NODE_PREFIX"
    tar -xJf "$tmpn/node.tar.xz" -C "$NODE_PREFIX"
    rm -rf "$tmpn"
    for b in node npm npx; do ln -sf "$NODE_PREFIX/node-v$NODE_VERSION-linux-x64/bin/$b" "/usr/local/bin/$b"; done
    ok "node $(node -v) / npm $(npm -v)"
  fi
fi

command -v node >/dev/null 2>&1 || die "缺少 node（用 --skip-deps 时必须已自行安装）"
command -v python3.11 >/dev/null 2>&1 || die "缺少 python3.11（用 --skip-deps 时必须已自行安装）"

# ------------------------------------------------------------------ 5. 代码 ---
step 5/8 "codeload 拉取代码 $REPO@$REF"
mkdir -p "$APP_DIR"
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
URL="https://codeload.github.com/$REPO/tar.gz/$REF"
echo "  GET $URL"
curl -fL --retry 3 --connect-timeout 20 -o "$TMPD/src.tar.gz" "$URL" \
  || die "代码下载失败（检查 ECS 出网 / GitHub 可达性）"
mkdir -p "$TMPD/src"
tar -xzf "$TMPD/src.tar.gz" -C "$TMPD/src" --strip-components=1
[ -d "$TMPD/src/viewer" ] || die "压缩包结构异常：没找到 viewer/"
# --delete 让服务器与仓库严格一致；运行数据与构建产物排除在外
rsync -a --delete \
  --exclude 'uploads/' --exclude 'logs/' --exclude 'secrets/' \
  --exclude 'node_modules/' --exclude 'dist/' --exclude '__cadgen__/' \
  --exclude '.env' \
  "$TMPD/src/" "$APP_DIR/"
mkdir -p "$APP_DIR/uploads" "$APP_DIR/logs" "$APP_DIR/secrets"
ok "代码已同步到 $APP_DIR（$(cd "$APP_DIR" && ls -d viewer tools 2>/dev/null | tr '\n' ' ')）"

if [ "$CODE_ONLY" -eq 1 ]; then
  warn "--code-only：不装依赖、不构建、不重启"
  exit 0
fi

# -------------------------------------------------------------- 6. CAD 环境 ---
step 6/8 "CAD Python 环境（OCP + build123d + cadgen）"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3.11 -m venv "$VENV_DIR"
  ok "新建 venv $VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install -q -U pip setuptools wheel -i "$PYPI_INDEX" \
  || { warn "阿里云 PyPI 镜像失败，回退官方源"; "$VENV_DIR/bin/python" -m pip install -q -U pip setuptools wheel; }

pipi() { "$VENV_DIR/bin/python" -m pip install -q "$@" -i "$PYPI_INDEX" || "$VENV_DIR/bin/python" -m pip install -q "$@"; }

if ! "$VENV_DIR/bin/python" - <<'PY' >/dev/null 2>&1
import OCP, build123d, cadgen.step_artifact  # noqa: F401
PY
then
  echo "  安装 OCP 7.9.3.1.1（novtk，headless）…"
  pipi "cadquery-ocp-novtk==7.9.3.1.1" "cadquery-ocp-proxy==7.9.3.1.1"
  echo "  安装 build123d 0.11.1 + 钉版依赖…"
  pipi "build123d==0.11.1" "ocp_gordon==0.2.2" "ocpsvg==0.6.0"
  pipi -e "$APP_DIR/viewer/packages/cadgen" --no-deps
  ok "CAD 依赖安装完成"
else
  # 代码可能是 editable 安装，rsync 后无需重装；但保证记录一致
  pipi -e "$APP_DIR/viewer/packages/cadgen" --no-deps >/dev/null
  ok "CAD 环境已存在，跳过安装"
fi

"$VENV_DIR/bin/python" - <<'PY' || die "CAD 环境校验失败（见上方报错）"
import OCP, build123d, cadgen.step_artifact
import importlib.metadata as m
for p in ("cadquery-ocp-novtk", "build123d", "cadgen", "numpy"):
    try: print(f"  {p:<20}{m.version(p)}")
    except Exception: pass
print("CAD 环境 OK")
PY

# ----------------------------------------------------------------- 7. 前端 ---
step 7/8 "前端依赖与构建（npm install + vite build）"
cd "$APP_DIR/viewer"
export npm_config_registry="$NPM_REGISTRY"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --registry="$NPM_REGISTRY" || npm install --no-audit --no-fund --registry="$NPM_REGISTRY"
else
  npm install --no-audit --no-fund --registry="$NPM_REGISTRY"
fi
rm -rf dist                     # 规避 vite emptyDir 偶发失败
npm run build
[ -f dist/index.html ] || die "构建产物缺失：$APP_DIR/viewer/dist/index.html"
ok "前端产物 $(du -sh dist | cut -f1) -> $APP_DIR/viewer/dist"

# --------------------------------------------------------------- 8. systemd ---
step 8/8 "systemd 单元 + 启动"
APP_DIR="$APP_DIR" CAD_PY="$VENV_DIR/bin/python" NODE_BIN="$(command -v node)" \
VIEWER_HOST="$VIEWER_HOST" VIEWER_PORT="$VIEWER_PORT" API_PORT="$API_PORT" \
CAD_WORKERS="$CAD_WORKERS" PREWARM_WORKERS="$PREWARM_WORKERS" \
URL_ALLOW_HOSTS="$URL_ALLOW_HOSTS" \
bash "$APP_DIR/tools/deploy/setup-systemd.sh"

# 冷启动要跑一次 OCP import 校验（默认预算 90s），别急着判失败
wait_http() {
  local url="$1" name="$2" limit="${3:-150}" i=0
  while [ "$i" -lt "$limit" ]; do
    if curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null; then ok "$name 就绪（${i}s）: $url"; return 0; fi
    i=$((i+3)); sleep 3
  done
  warn "$name 在 ${limit}s 内未就绪：$url（看日志 $APP_DIR/logs/*.err.log）"
  return 1
}
wait_http "http://127.0.0.1:$VIEWER_PORT/__cad/server" "viewer :$VIEWER_PORT" 180 || true
wait_http "http://127.0.0.1:$API_PORT/healthz" "upload api :$API_PORT" 60 || true

KEY=$(cat "$APP_DIR/secrets/api.key" 2>/dev/null || echo '')
cat <<EOF

${C_OK}部署完成${C_RESET}
  查看器    : http://$VIEWER_HOST:$VIEWER_PORT/
  上传 API  : http://$VIEWER_HOST:$API_PORT/api/v1/jobs
  API key   : $KEY
  日志      : $APP_DIR/logs/{viewer,api}.log / *.err.log
  服务管理  : systemctl restart step-viewer step-upload-api
              （⚠️ api 单元 Requires=viewer，重启 viewer 会连带停 api，两个一起 restart）
EOF

# ---------------------------------------------------------------- 自检(可选) ---
if [ "$DO_SELFTEST" -eq 1 ]; then
  step "selftest" "端到端自检：造一个 STEP → 上传 → 轮询到 ready"
  TMPT=$(mktemp -d)
  "$VENV_DIR/bin/python" - "$TMPT" <<'PY'
import sys, pathlib
from build123d import Box, Cylinder, Pos, export_step
out = pathlib.Path(sys.argv[1]) / "selftest-part.STEP"
part = Box(40, 30, 20) - Pos(0, 0, 0) * Cylinder(6, 40)
export_step(part, str(out))
print("  step file:", out, out.stat().st_size, "bytes")
PY
  RESP=$(curl -fsS -m 120 -X POST "http://127.0.0.1:$API_PORT/api/v1/jobs" \
    -H "Authorization: Bearer $KEY" \
    -F "step=@$TMPT/selftest-part.STEP" \
    -F "stepName=selftest-part.STEP") || die "POST 失败（API 没起来 / key 不对）"
  echo "  POST -> $RESP"
  JOB=$(printf '%s' "$RESP" | "$VENV_DIR/bin/python" -c 'import sys,json;print(json.load(sys.stdin).get("jobId",""))')
  [ -n "$JOB" ] || die "响应里没有 jobId"
  for i in $(seq 1 40); do
    J=$(curl -fsS -m 10 "http://127.0.0.1:$API_PORT/api/v1/jobs/$JOB" -H "Authorization: Bearer $KEY")
    IFS='|' read -r STATUS PREWARM VURL ERRMSG <<<"$(printf '%s' "$J" | "$VENV_DIR/bin/python" -c '
import sys, json
d = json.load(sys.stdin)
r = d.get("result") or {}
print("%s|%s|%s|%s" % (d.get("status"), d.get("prewarm"), r.get("viewerUrl", ""), d.get("error") or ""))')"
    echo "  [$i] status=$STATUS prewarm=$PREWARM ${VURL:-<无 viewerUrl>} ${ERRMSG:+err=$ERRMSG}"
    case "$STATUS" in
      failed|error)    warn "任务失败：$ERRMSG"; break ;;
      landed|ready|prewarmed)
                       ok "端到端通过（$STATUS / prewarm=$PREWARM）"; break ;;
    esac
    sleep 3
  done
  # 产物落盘检查
  ls -la "$APP_DIR/uploads/$JOB" 2>/dev/null || warn "任务目录不存在"
  find "$APP_DIR/uploads/$JOB" -name '*.glb' -printf '  GLB: %p %s bytes\n' 2>/dev/null | head -5
  rm -rf "$TMPT"
fi
