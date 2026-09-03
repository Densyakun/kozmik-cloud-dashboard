---
applyTo: '**'
---

# Kozmik Cloud Dashboard - プロジェクトメモ

## Goal
- GitHub CodespacesとOna Cloudの開発環境をスマホから管理するWebアプリ（kozmik-cloud-dashboard）。opencodeをCodespace内で起動・公開できる。

## Constraints & Preferences
- スマホ（同じLAN・`http://<PCのIP>:3000`）から操作可能
- `.env.local`で認証情報を設定（ブラウザには渡さない）
- `GITHUB_CODESPACES_TOKEN` / `ONA_PERSONAL_ACCESS_TOKEN` / `OPENCODE_API_KEY`
- opencode認証は `OPENCODE_SERVER_USERNAME`（既定`opencode`）と `OPENCODE_SERVER_PASSWORD`（デフォルト値は `kozmik-cloud-dashboard/.env.local` と `.devcontainer/opencode-serve.sh` を参照。実値はコミットしない）。devcontainer と dashboard で同一デフォルト。**公開URLを知る全員がログインできるため実運用前に必ず変更**
- SSH連携はCodespacesとOnaのPersonal access tokenのみ（SSH_API_URL不要）
- 停止中Codespaceは自動起動、環境削除はユーザー確認
- opencodeのURL/ID/PASSはカード表示、コピーはURL・ID・パスワード別々
- 状態不明時は「未起動」と表示しない（codespace state と opencode 応答を分けて表示）

## Progress
### Done
- Codespaces一覧・作成・停止・起動・削除（REST API、default_branchをrefに使用）
- Ona Cloud環境一覧・削除（Connect API、リダイレクト時にAuthorization再付与`onaApi()`）
- **Ona環境作成を再実装**: `POST /api/environments`に`provider:'ona'`分岐、`GET /api/ona/classes`、createダイアログにprovider選択(GitHub/Ona)+OnaのリポジトリURL/マシンクラス欄、Billingエラー時は`403 needs_subscription`+Billingリンク表示
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
- `.env.local.example`に`OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`/`ONA_API_HOST`を記載

### Blocked (Ona作成)
- Ona `CreateEnvironment`は**スキーマは受付る**が、組織に**アクティブなsubscription/契約がない**ため`failed_precondition`（"requires an active subscription... Settings > Billing"）で不可。実装済み・Billing開始で利用可
- `ListEnvironmentClasses`で環境クラス取得可: Small=`01a03de0-7b31-7dfc-87b2-f4cb692f5d86`(2vCPU/8GiB/50GiB)、Regular=`01a03de0-7b31-7e09-9e21-b8fb710965d8`(4vCPU/16GiB/80GiB)、runner=`01a03de0-5343-78e1-bc10-9f67c530a4b2`(Ona Cloud US01, ACTIVE)

### Vercel（現行の自己ホスト方式では不可 → 薄い制御面アーキテクチャなら可）
- **現行方式（opencodeのローカル転送/トンネル常駐）はVercel不可**。AUPの"proxy"/"undue burden"禁止、Hobbyの個人用途限定、関数のステートレス性（microVM・read-only fs・`/tmp`上限・実行時間Hobby max 300s/Pro max 800s、Large functions 5GB、Node.js "Full coverage"）。
- **「Vercel=薄い制御面+Codespace内でopencode serve+公開URL」案は技術的に成立**することを確認:
  - Vercel関数は`fetch`でGitHub RESTのみ叩くなら完全ステートレス&短時間で、AUP違反にならない（プロキシ中継をしないため）。
  - Codespacesのポート公開URLは`https://<codespace>-<port>.app.github.dev`で、**Codespacesインフラが提供**。`gh codespace ports visibility <port>:public`で公開設定可能。
  - `portsAttributes`(devcontainer.json)にはGitHub Codespaces独自の`visibility`が使える（本プロジェクトで設定済み）
  - Vercel関数からのアウトバウンドは自由（SSH port22へも可）。SSH不要なら`gh`/`ssh`同梱も不要。
  - **ヘッドレス（API/CLI作成・エディタ未接続）Codespaceでも postStartCommand は実行される**（`gh codespace rebuild` 後のコンテナ再作成時に確認済み）。→ devcontainerに`forwardPorts`+`portsAttributes`+`postStartCommand`を仕込めば公開URL形態の自動起動が成立。Vercel側はRESTでcreate/startのみ制御し公開URLを返す。
- **Vercel化の現実的な選択肢**: (A) devcontainer自己構成+全SSH廃止(最軽量/RESTのみ), (B) `gh`をLarge functionに同梱しSSH exec（重い）。

### Research (Ona新製品 = Gitpod Flexベース)
- APIはConnect RPC、`{host}/api/gitpod.v1.<Service>/<Method>`。トークンのissは`app.gitpod.io`。`onaApi()`(server.js)は308リダイレクトにAuthorization再付与で追従（app.ona.com→app.gitpod.io）
- **CreateEnvironmentのスキーマ**: `{spec:{specVersion:"1", machine:{class:"<環境クラスUUID>"}, content:{initializer:{specs:[{contextUrl:{url:"<gitURL>"}}]}}}, name?}`（`EnvironmentSpec`）。`machine.class`は`ListEnvironmentClasses`の`environmentClasses[].id`(UUID)
- **ont問わず実行方法**: `ona environment exec <id> -- <cmmd>`(EnvironmentOps API, SSH不要) / `ona environment ssh <id> -- <cmmd>`。環境は**起動中**であること
- 現状: opencode serveはCodespaces専用(`/api/opencode/*` はgithub依存)。Onaのopencode起動は未実装（実装判断保留）

### 無料枠の結論 (Ona公式 pricing, 2026-08確認)
- **Ona新製品に無料枠は存在しない**。公式Pricingは **Core $20/月〜** と **Enterprise(カスタム)** の2プランのみ。OCU制（80〜2200込み、追加$10/40 OCU）。Coreは100人まで/並列無制限/32vCPU・128G・200Gディスク/GPU対応。
- → 「無料枠があるはず」は**旧Gitpodの無料プラン**との混同。サインアップ時のorgは契約無しで作られるため、List/Create等のスキーマ検証は通るが、実プロビジョニングに契約が必要。
- **$20/月を払わない限りOnaで環境作成は不可**。以後のOna作成サポートはBilling有効化が前提。

## Key Decisions
- **opencodeの起動・公開は Codespace 内 devcontainer の postStartCommand に集約**（ローカルPC常駐・SSH転送・トンネル方式は廃止）。dashboardはRESTで start/stop とヘルスチェックのみ行う
- 認証情報は devcontainer `env` + 起動スクリプト内 export（Codespacesシークレット不使用）。ポート公開時は Basic 認証が保護レイヤー
- 稼働判定は `GET /global/health`（Basic認証付き・`--max-time`/`AbortController`でタイムアウト）
- `gh codespace ssh -c` はシングルクォートで送らないとPowerShellがローカル展開（`$HOME`等の見かけが偽になる）。また引用符を剥がすため複雑コマンドは避ける
- Vercelデプロイはユーザー自身が行う

## Relevant Files
- `kozmik-cloud-dashboard/server.js`: 全サーバーロジック（GitHub/Ona API、/api/opencode/*）
- `kozmik-cloud-dashboard/api/_lib/index.js`: `opencodeCredentials` / `probeOpenCodeHealth` / `codespaceForwardUrl` / `describeCodespaceState`
- `kozmik-cloud-dashboard/api/opencode/status.js` と `serve.js`: Vercel関数版（server.js と同一ロジック）
- `kozmik-cloud-dashboard/public/app.js`: カードUI、状態ポーリング(5s)、ID/PASSコピー
- `kozmik-cloud-dashboard/public/index.html` / `public/style.css`: UI（`.os-pw` / `.os-copy-row` / `.os-badge.checking` 等はstyle.cssに既存）
- `kozmik-cloud-dashboard/.env.local.example`: 環境変数テンプレート（`.env.local`はgitignore対象）
- `Densyakun/densyakun.github.io/.devcontainer/devcontainer.json`: forwardPorts=4096 + `visibility:public` + postStartCommand=wrapper
- `Densyakun/densyakun.github.io/.devcontainer/oc-boot-wrapper.sh`: postStart用ラッパー（`/tmp/oc-boot.log`に診断）
- `Densyakun/densyakun.github.io/.devcontainer/opencode-serve.sh`: 常駐起動スクリプト（v4, インストールリトライ・プローブ・自動再起動）