---
applyTo: '**'
---

# Kozmik Cloud Dashboard - プロジェクトメモ

## Goal
- GitHub Codespacesの開発環境をスマホから管理するWebアプリ（kozmik-cloud-dashboard）。opencodeをCodespace内で起動・公開できる。※Ona Cloud関連機能は2026-09削除済み

## Constraints & Preferences
- スマホ（同じLAN・`http://<PCのIP>:3000`）から操作可能
- `.env.local`で認証情報を設定（ブラウザには渡さない）
- `GITHUB_CODESPACES_TOKEN` / `OPENCODE_API_KEY`
- opencode認証は `OPENCODE_SERVER_USERNAME`（既定`opencode`）と `OPENCODE_SERVER_PASSWORD`（デフォルト値は `kozmik-cloud-dashboard/.env.local` と `.devcontainer/opencode-serve.sh` を参照。実値はコミットしない）。devcontainer と dashboard で同一デフォルト。**公開URLを知る全員がログインできるため実運用前に必ず変更**
- SSH連携はCodespacesのPersonal access tokenのみ（SSH_API_URL不要）
- 停止中Codespaceは自動起動、環境削除はユーザー確認
- opencodeのURL/ID/PASSはカード表示、コピーはURL・ID・パスワード別々
- 状態不明時は「未起動」と表示しない（codespace state と opencode 応答を分けて表示）

## Progress
### Done
- Codespaces一覧・作成・停止・起動・削除（REST API、default_branchをrefに使用）
- **opencodeをCodespace内で自動常駐させる新方式**（旧ローカルSSH転送方式から全面変更）:
  - Densyakun/densyakun.github.io の `.devcontainer/` に構成を集約
  - `postStartCommand` = `oc-boot-wrapper.sh`（環境・起動状態を `/tmp/oc-boot.log` に記録）→ `(setsid nohup bash opencode-serve.sh &)` で分離起動
  - `opencode-serve.sh` (v4): バイナリ不在なら ①公式インストーラを`--version 1.18.27 --no-modify-path`固定で実行（GitHub APIの最新版取得を回避）②リリースtarball直接DL=`https://github.com/anomalyco/opencode/releases/download/v1.18.27/opencode-linux-x64.tar.gz`をフォールバック。**決してexitしない**（リトライループ）。その後ポート4096をポーリング（200/401なら起動済み、それ以外なら起動）
  - **重要: インストーラはバージョン未指定だと `api.github.com` の最新版取得に失敗し「Failed to fetch version information」で死ぬ**（Codespaces起動直後に発生。`--version` 固定で回避済み）
  - `curl -w %{http_code}` の判定で `|| echo` を足すと `000000` に化けて判定が壊れる（参考・回避済み）
  - ポート4096を `portsAttributes` で `public` 転送（devcontainerは`forwardPorts`+`visibility`必須。再ビルド後に `gh codespace ports visibility 4096:public` を再適用する場合あり）
  - 公開URL: `https://<codespace>-4096.app.github.dev` / opencodeのBasic認証レイヤーが保護（WWW-Authenticate: Basic）
- **稼働判定は `/global/health` を Basic 認証付きでプローブ**（codespace state が Available でも opencode が未起動のことがあるため）
- dashboard側改修（コミット`40c8b9c`）: `api/_lib/index.js` に `opencodeCredentials(env)` / `probeOpenCodeHealth(publicUrl,{env,timeoutMs=4000})` を追加。`api/opencode/status.js` と `server.js` は running でもヘルスチェックし `opencode:'running'|'starting'|'error'`・`auth`・`version`・`opencodeDetail` を返す。`api/opencode/serve.js` にも `auth` を付与。`public/app.js` の `renderOpenCodeBadge` に ID/PASS表示とコピーボタン（`data-copy="user"`/`"pw"`）を追加
- **エンドツーエンド確認済み（2026-09-03）**: postStartからのコールドスタートで自動起動→公開URLで匿名401 / 認証200 / `GET /global/health`=`{"healthy":true,"version":"1.18.27"}`。ローカル`node server.js`(PORT=3200)でもstatus APIが `opencode:"running"` を返すことを確認
- 各カードにOpenCode起動、停止/起動、Open workspace、削除ボタン
- `.env.local.example`に`OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`を記載

### Vercel（現行の自己ホスト方式では不可 → 薄い制御面アーキテクチャなら可）
- **現行方式（opencodeのローカル転送/トンネル常駐）はVercel不可**。AUPの"proxy"/"undue burden"禁止、Hobbyの個人用途限定、関数のステートレス性（microVM・read-only fs・`/tmp`上限・実行時間Hobby max 300s/Pro max 800s、Large functions 5GB、Node.js "Full coverage"）。
- **「Vercel=薄い制御面+Codespace内でopencode serve+公開URL」案は技術的に成立**することを確認:
  - Vercel関数は`fetch`でGitHub RESTのみ叩くなら完全ステートレス&短時間で、AUP違反にならない（プロキシ中継をしないため）。
  - Codespacesのポート公開URLは`https://<codespace>-<port>.app.github.dev`で、**Codespacesインフラが提供**。`gh codespace ports visibility <port>:public`で公開設定可能。
  - `portsAttributes`(devcontainer.json)にはGitHub Codespaces独自の`visibility`が使える（本プロジェクトで設定済み）
  - Vercel関数からのアウトバウンドは自由（SSH port22へも可）。SSH不要なら`gh`/`ssh`同梱も不要。
  - **ヘッドレス（API/CLI作成・エディタ未接続）Codespaceでも postStartCommand は実行される**（`gh codespace rebuild` 後のコンテナ再作成時に確認済み）。→ devcontainerに`forwardPorts`+`portsAttributes`+`postStartCommand`を仕込めば公開URL形態の自動起動が成立。Vercel側はRESTでcreate/startのみ制御し公開URLを返す。
- **Vercel化の現実的な選択肢**: (A) devcontainer自己構成+全SSH廃止(最軽量/RESTのみ), (B) `gh`をLarge functionに同梱しSSH exec（重い）。

## Key Decisions
- **opencodeの起動・公開は Codespace 内 devcontainer の postStartCommand に集約**（ローカルPC常駐・SSH転送・トンネル方式は廃止）。dashboardはRESTで start/stop とヘルスチェックのみ行う
- 認証情報は devcontainer `env` + 起動スクリプト内 export（Codespacesシークレット不使用）。ポート公開時は Basic 認証が保護レイヤー
- 稼働判定は `GET /global/health`（Basic認証付き・`--max-time`/`AbortController`でタイムアウト）
- `gh codespace ssh -c` はシングルクォートで送らないとPowerShellがローカル展開（`$HOME`等の見かけが偽になる）。また引用符を剥がすため複雑コマンドは避ける
- Vercelデプロイはユーザー自身が行う

## Relevant Files
- `kozmik-cloud-dashboard/server.js`: 全サーバーロジック（GitHub API、/api/opencode/*）
- `kozmik-cloud-dashboard/api/_lib/index.js`: `opencodeCredentials` / `probeOpenCodeHealth` / `codespaceForwardUrl` / `describeCodespaceState`
- `kozmik-cloud-dashboard/api/opencode/status.js` と `serve.js`: Vercel関数版（server.js と同一ロジック）
- `kozmik-cloud-dashboard/public/app.js`: カードUI、状態ポーリング(5s)、ID/PASSコピー
- `kozmik-cloud-dashboard/public/index.html` / `public/style.css`: UI（`.os-pw` / `.os-copy-row` / `.os-badge.checking` 等はstyle.cssに既存）
- `kozmik-cloud-dashboard/.env.local.example`: 環境変数テンプレート（`.env.local`はgitignore対象）
- `Densyakun/densyakun.github.io/.devcontainer/devcontainer.json`: forwardPorts=4096 + `visibility:public` + postStartCommand=wrapper
- `Densyakun/densyakun.github.io/.devcontainer/oc-boot-wrapper.sh`: postStart用ラッパー（`/tmp/oc-boot.log`に診断）
- `Densyakun/densyakun.github.io/.devcontainer/opencode-serve.sh`: 常駐起動スクリプト（v4, インストールリトライ・プローブ・自動再起動）