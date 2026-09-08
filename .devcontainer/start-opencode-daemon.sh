#!/usr/bin/env bash
# start-opencode-daemon.sh
# ---------------------------------------------------------------------------
# opencode web サーバーの常駐監視デーモン。
# start-opencode.sh から setsid で分離起動され、独立セッションで動作する。
# opencode が未応答なら起動し、クラッシュ時には再起動する（無限ループ）。
#
# 注意: これは「デーモン」であり、postStartCommand のプロセスではないため、
#       無限ループでも Codespaces の起動(Provisioning)を妨げない。
# ---------------------------------------------------------------------------
set -u

: "${OPENCODE_PORT:=4096}"
: "${OPENCODE_HOST:=0.0.0.0}"
: "${OPENCODE_BIN:=$HOME/.opencode/bin/opencode}"

LOG=/tmp/opencode-supervisor.log
PIDFILE=/tmp/opencode.pid

log() { echo "[opencode-supervisor] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG"; }

export PATH="$HOME/.opencode/bin:$PATH"
export BROWSER=true
export OPENCODE_DISABLE_AUTOUPDATE=true

run_t() {
  if command -v timeout >/dev/null 2>&1; then timeout "$1" "${@:2}"; else "${@:2}"; fi
}

# 応答確認：HTTP 200 が返れば稼働中とみなす
opencode_alive() {
  local code
  code="$( (run_t 5 curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$OPENCODE_PORT/" || true) 2>/dev/null )"
  [ "$code" = "200" ]
}

# 念のため古い pidfile を掃除
rm -f "$PIDFILE"

log "opencode 監督デーモン開始（port=$OPENCODE_PORT）"
while true; do
  if opencode_alive; then
    : # 稼働中 → 何もしない
  elif ! command -v "$OPENCODE_BIN" >/dev/null 2>&1 && [ ! -x "$OPENCODE_BIN" ]; then
    log "opencode バイナリが無いため起動できません（再試行を続行）"
  else
    log "未応答のため opencode web を起動します"
    nohup "$OPENCODE_BIN" web --hostname "$OPENCODE_HOST" --port "$OPENCODE_PORT" >>/tmp/opencode.log 2>&1 &
    OPENCODE_PID=$!
    disown 2>/dev/null || true
    echo "$OPENCODE_PID" > "$PIDFILE"
  fi
  sleep 15
done
