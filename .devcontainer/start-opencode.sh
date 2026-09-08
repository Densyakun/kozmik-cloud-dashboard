#!/usr/bin/env bash
# start-opencode.sh
# ---------------------------------------------------------------------------
# opencode 本体（webサーバー）を Codespace 内で常駐起動する。
# 1) 設定（config-opencode）を ~/.config/opencode へ反映（上書き方式・タイムアウト付き）
# 2) opencode を未インストールなら導入
# 3) opencode web を常駐起動し、クラッシュ時に再起動
#
# このスクリプトは一切ハングしない（各外部アクセスに timeout を適用）。
# 設定同期に失敗しても opencode 自体は起動する。
# ---------------------------------------------------------------------------
set -u

: "${OPENCODE_PORT:=4096}"
: "${OPENCODE_HOST:=0.0.0.0}"
: "${OPENCODE_BIN:=$HOME/.opencode/bin/opencode}"
: "${CONFIG_DIR:=$HOME/.config/opencode}"
: "${CONFIG_REPO:=https://gitlab.com/Densyakun/config-opencode.git}"
: "${TMP_CLONE:=$HOME/.opencode-config-tmp}"
: "${GITLAB_TOKEN:=$PRESENCE_GITLAB_TOKEN}"

log() { echo "[start-opencode] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

export BROWSER=true
export OPENCODE_DISABLE_AUTOUPDATE=true
export PATH="$HOME/.opencode/bin:$PATH"
export GIT_TERMINAL_PROMPT=0

# タイムアウト付き実行ラッパー（外部コマンドのハング防止）
run_t() {
  if command -v timeout >/dev/null 2>&1; then timeout "$1" "${@:2}"; else "${@:2}"; fi
}

# ---- 1) 設定の反映 ---------------------------------------------------------
sync_config() {
  mkdir -p "$CONFIG_DIR"
  local auth_url="$CONFIG_REPO"
  if [ -n "$GITLAB_TOKEN" ]; then
    auth_url="$(printf '%s' "$CONFIG_REPO" | sed -E 's#(https?://)[^@]*@#\1#; s#^https?://#&oauth2:'"$GITLAB_TOKEN"'@#')"
  fi
  if [ -d "$TMP_CLONE/.git" ]; then
    run_t 30 git -C "$TMP_CLONE" remote set-url origin "$auth_url" 2>/dev/null || true
    run_t 30 git -C "$TMP_CLONE" fetch --depth 1 origin main 2>/dev/null || true
    run_t 30 git -C "$TMP_CLONE" reset --hard origin/main 2>/dev/null || true
  else
    rm -rf "$TMP_CLONE"
    run_t 30 git clone --depth 1 "$auth_url" "$TMP_CLONE" 2>/dev/null || { log "設定のcloneに失敗（スキップ）"; return 0; }
  fi
  [ -d "$TMP_CLONE/.git" ] || { log "設定リポジトリが取得できません（スキップ）"; return 0; }

  local count=0
  while IFS= read -r -d '' f; do
    local src="$TMP_CLONE/$f" dst="$CONFIG_DIR/$f"
    if [ -f "$src" ]; then
      mkdir -p "$(dirname "$dst")"
      cp -f "$src" "$dst"
      count=$((count + 1))
    fi
  done < <(git -C "$TMP_CLONE" ls-files -z 2>/dev/null)
  rm -rf "$TMP_CLONE"
  log "設定を反映しました（${count}ファイル）"
}

sync_config

# ---- 2) opencode の導入 ----------------------------------------------------
if [ ! -x "$OPENCODE_BIN" ]; then
  log "opencode をインストールします"
  run_t 120 curl -fsSL https://opencode.ai/install | bash >/tmp/opencode-install.log 2>&1 || true
fi
if [ ! -x "$OPENCODE_BIN" ]; then
  log "opencode が見つかりません（$OPENCODE_BIN）。起動を継続します"
fi

# ---- 3) 常駐起動 -----------------------------------------------------------
log "opencode 常駐起動を開始します（port=$OPENCODE_PORT）"
while true; do
  code="$(run_t 10 curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$OPENCODE_PORT/" 2>/dev/null || echo 000)"
  if [ "$code" = "000" ]; then
    log "未応答のため opencode web を起動します"
    nohup "$OPENCODE_BIN" web --hostname "$OPENCODE_HOST" --port "$OPENCODE_PORT" >>/tmp/opencode.log 2>&1 &
  fi
  sleep 15
done
