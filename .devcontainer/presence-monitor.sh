#!/usr/bin/env bash
# presence-monitor.sh
# ---------------------------------------------------------------------------
# Codespace 内で自走する「自動停止モニター」。
# ダッシュボードの監視スイッチ（opencode-workspace リポジトリの presence
# ブランチに置く presence.json の "monitoring"）が OFF(=不在) で、かつ
# opencode の全セッションが完了(busy でない)場合に、自分自身を停止する。
#
# 依存: curl / 環境変数 CODESPACE_NAME, GITHUB_TOKEN（Codespaces が自動注入）
#       OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD（opencode の Basic 認証、任意）
# ---------------------------------------------------------------------------
set -u

: "${OPENCODE_PORT:=4096}"
: "${OPENCODE_HOST:=127.0.0.1}"
: "${OPENCODE_SERVER_USERNAME:=opencode}"
# presence.json の取得先（監視スイッチの状態置き場）。
# 既定は GitHub の opencode-workspace リポジトリの専用ブランチ `presence`。
# 在席⇄離席の切り替えは頻繁に起きる「状態」であり、main ブランチの履歴を
# 汚染しないよう、状態は main とは別ブランチに置く。
# 読み取りは Codespaces が自動注入する GITHUB_TOKEN を使うため、追加の
# シークレット設定は不要。環境変数 PRESENCE_URL で取得先を上書きできる。
: "${PRESENCE_REPO:=Densyakun/opencode-workspace}"
: "${PRESENCE_BRANCH:=presence}"
: "${PRESENCE_FILE:=presence.json}"
: "${PRESENCE_URL:=https://raw.githubusercontent.com/${PRESENCE_REPO}/${PRESENCE_BRANCH}/${PRESENCE_FILE}}"
: "${CONFIG_DIR:=$HOME/.config/opencode}"
: "${MONITOR_INTERVAL:=60}"
: "${GRACE_IDLE_BEFORE_STOP:=180}"
# 旧保存先（GitLab config-opencode）用のトークン。PRESENCE_URL を GitLab に
# 向けた場合の後方互換用。通常は未設定のままでよい。
: "${PRESENCE_GITLAB_TOKEN:=}"

log() { echo "[presence-monitor] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# 1) 監視スイッチ（presence）を読む。デフォルトは「監視中=true（停止しない）」。
presence_monitoring() {
  local raw=""
  case "$PRESENCE_URL" in
    *gitlab.com*)
      # 後方互換: 旧保存先（GitLab config-opencode）を PRESENCE_URL で指定した場合
      if [ -n "$PRESENCE_GITLAB_TOKEN" ]; then
        raw="$(curl -fsS --max-time 15 -H "PRIVATE-TOKEN: $PRESENCE_GITLAB_TOKEN" "$PRESENCE_URL" 2>/dev/null || true)"
      fi
      ;;
    *)
      # 既定: GitHub の presence ブランチ。GITHUB_TOKEN は Codespaces が自動注入
      if [ -n "${GITHUB_TOKEN:-}" ]; then
        raw="$(curl -fsS --max-time 15 -H "Authorization: Bearer $GITHUB_TOKEN" "$PRESENCE_URL" 2>/dev/null || true)"
      fi
      ;;
  esac
  if [ -z "$raw" ] && [ -f "$CONFIG_DIR/presence.json" ]; then
    raw="$(cat "$CONFIG_DIR/presence.json" 2>/dev/null || true)"
  fi
  # monitoring の明示的な false のみを「不在」とみなす。読めない場合は監視中(安全側)。
  case "$(echo "$raw" | grep -o '"monitoring"[[:space:]]*:[[:space:]]*[a-z]*' | grep -o '[a-z]*$')" in
    false) echo "false" ;;
    *) echo "true" ;;
  esac
}

# 2) opencode のセッション状態を取得し、1つでも busy なら「稼働中」とする。
sessions_busy() {
  local body=""
  if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    body="$(curl -fsS --max-time 10 -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" "http://$OPENCODE_HOST:$OPENCODE_PORT/session/status" 2>/dev/null || true)"
  else
    body="$(curl -fsS --max-time 10 "http://$OPENCODE_HOST:$OPENCODE_PORT/session/status" 2>/dev/null || true)"
  fi
  # "type":"busy" が存在すれば稼働中。JSON が読めない/空なら稼働中とみなし停止しない。
  if [ -z "$body" ]; then echo "true"; return; fi
  echo "$body" | grep -q '"type"[[:space:]]*:[[:space:]]*"busy"' && echo "true" || echo "false"
}

# 3) 自分自身（Codespace）を停止する。
stop_self() {
  if [ -z "${CODESPACE_NAME:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
    log "CODESPACE_NAME/GITHUB_TOKEN が無いため自動停止できません"
    return 1
  fi
  log "全セッション完了・監視OFF のため Codespace を停止します: $CODESPACE_NAME"
  curl -fsS --max-time 60 -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/user/codespaces/$CODESPACE_NAME/stop" \
    >/dev/null 2>&1 || log "停止APIの呼び出しに失敗"
}

idle_since=""
log "監視ループ開始（interval=${MONITOR_INTERVAL}s, grace=${GRACE_IDLE_BEFORE_STOP}s）"
while true; do
  monitoring="$(presence_monitoring)"
  busy="$(sessions_busy)"

  if [ "$monitoring" = "true" ]; then
    log "監視中(ON)のため自動停止しません"
    idle_since=""
  elif [ "$busy" = "true" ]; then
    log "エージェント稼働中(busy)のため停止しません"
    idle_since=""
  else
    now="$(date +%s)"
    if [ -z "$idle_since" ]; then
      idle_since="$now"
      log "不在(OFF)かつ全セッション完了。猶予を計測開始"
    else
      elapsed=$(( now - idle_since ))
      log "不在かつ完了状態が ${elapsed}s 継続（猶予 ${GRACE_IDLE_BEFORE_STOP}s）"
      if [ "$elapsed" -ge "$GRACE_IDLE_BEFORE_STOP" ]; then
        stop_self
        exit 0
      fi
    fi
  fi

  sleep "$MONITOR_INTERVAL"
done
