#!/usr/bin/env bash
# setup-opencode-config.sh
# ---------------------------------------------------------------------------
# opencode の設定（config-opencode GitLab リポジトリ）を ~/.config/opencode へ
# 「上書き反映」する。opencode が生成する node_modules / package.json 等は残すため、
# git clone ではなく「一時ディレクトリへ clone → 追跡ファイルのみコピー」する。
#
# 目的: ローカルと同一の config / skills / commands / plugins をクラウドでも使う。
# ---------------------------------------------------------------------------
set -u

: "${CONFIG_DIR:=$HOME/.config/opencode}"
: "${CONFIG_REPO:=https://gitlab.com/Densyakun/config-opencode.git}"
: "${TMP_CLONE:=$HOME/.opencode-config-tmp}"

log() { echo "[setup-config] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

mkdir -p "$CONFIG_DIR"

# 一時ディレクトリへ clone（既存があれば pull）
if [ -d "$TMP_CLONE/.git" ]; then
  git -C "$TMP_CLONE" fetch --depth 1 origin main 2>/dev/null || true
  git -C "$TMP_CLONE" reset --hard origin/main 2>/dev/null || true
else
  rm -rf "$TMP_CLONE"
  git clone --depth 1 "$CONFIG_REPO" "$TMP_CLONE" 2>/dev/null || { log "clone失敗"; exit 0; }
fi

if [ ! -d "$TMP_CLONE" ]; then log "clone先がありません"; exit 0; fi

# 追跡対象ファイルのみを ~/.config/opencode へコピー（node_modules 等の生成物は残す）
log "追跡ファイルを $CONFIG_DIR に反映します"
git -C "$TMP_CLONE" ls-files -z | while IFS= read -r -d '' f; do
  src="$TMP_CLONE/$f"
  dst="$CONFIG_DIR/$f"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -f "$src" "$dst"
  fi
done

# .git は opencode の生成物と混在させない（config dir を git 管理しない）
rm -rf "$TMP_CLONE"

log "設定の反映が完了しました"
