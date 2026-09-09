# Kotlin-like lightweight base for the OpenCode Codespace.
# 目標: Codespaces の起動を高速化する。
#   以前: mcr.microsoft.com/devcontainers/universal:2（数GB・pull に数分）を要求
#   今回: debian:12-slim（~80MB）+ 最小限のツール群 + opencode をビルド時にプリインストール
#  → 初回作成も短時間、キャッシュ後はさらに高速になる。
#
# 必要なツール: opencode 本体(インストーラ)と各コアスクリプトの要求に限定。
#   - curl      : opencode インストール / presence.json 取得 / Codespaces停止API / ヘルスチェック
#   - git       : private config-opencode の同期（git clone / fetch / reset）
#   - tar, sed, grep : opencode インストーラが使用
#   - ca-certificates : TLS（gitlab.com / github.com / opencode.ai）
#   - util-linux : setsid（postStartCommand からデーモンを分離起動するために必須）
#   - openssl    : public ポートを守る Basic 認証パスワードの生成
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/root \
    PATH="/root/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    BROWSER=true \
    OPENCODE_DISABLE_AUTOUPDATE=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        tar \
        sed \
        grep \
        util-linux \
        openssl \
    && rm -rf /var/lib/apt/lists/*

# opencode をビルド時にプリインストールする（起動時にダウンロード待ちをさせない）。
RUN curl -fsSL https://opencode.ai/install | bash

CMD ["/bin/bash"]
