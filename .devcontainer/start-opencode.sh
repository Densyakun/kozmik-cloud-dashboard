#!/usr/bin/env bash
# start-opencode.sh
# ---------------------------------------------------------------------------
# opencode 本体（webサーバー）を Codespace 内で常駐起動する。
# インストールされていなければ公式インストーラで導入し、クラッシュ時は再起動する。
# このスクリプトは opencode 起動にのみ責任を持ち、config 同期や停止モニターを含めない。
# ---------------------------------------------------------------------------
set -u

: "${OPENCODE_PORT:=4096}"
: "${OPENCODE_HOST:=0.0.0.0}"
: "${OPENCODE_BIN:=$HOME/.opencode/bin/opencode}"

log() { echo "[start-opencode] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

export BROWSER=true
export OPENCODE_DISABLE_AUTOUPDATE=true
export PATH="$HOME/.opencode/bin:$PATH"

# opencode 本体が無ければ公式インストーラで導入
if [ ! -x "$OPENCODE_BIN" ]; then
  log "opencode をインストールします"
  curl -fsSL https://opencode.ai/install | bash >/tmp/opencode-install.log 2>&1 || true
fi
if [ ! -x "$OPENCODE_BIN" ]; then
  log "opencode のインストールに失敗しました: $OPENCODE_BIN がありません"
  exit 1
fi

log "opencode 常駐起動を開始します（port=$OPENCODE_PORT）"
while true; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$OPENCODE_PORT/" 2>/dev/null || echo 000)"
  if [ "$code" = "000" ]; then
    log "未応答のため opencode web を起動します"
    nohup "$OPENCODE_BIN" web --hostname "$OPENCODE_HOST" --port "$OPENCODE_PORT" >>/tmp/opencode.log 2>&1 &
  fi
  sleep 15
done
