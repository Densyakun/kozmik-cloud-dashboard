---
applyTo: '**'
---

# Cloud Deck - プロジェクトメモ

## Goal
- GitHub CodespacesとOna Cloudの開発環境をスマホから管理するWebアプリ（cloud-deck）。opencodeをワークスペースで起動・公開できる。

## Constraints & Preferences
- スマホ（同じLAN・`http://<PCのIP>:3000`）から操作可能
- `.env.local`で認証情報を設定（ブラウザには渡さない）
- `GITHUB_CODESPACES_TOKEN` / `ONA_PERSONAL_ACCESS_TOKEN` / `OPENCODE_API_KEY`
- `OPENCODE_SERVER_USERNAME`（既定`opencode`）と`OPENCODE_SERVER_PASSWORD`（未設定なら毎回ランダム生成）
- SSH連携はCodespacesとOnaのPersonal access tokenのみ（SSH_API_URL不要）
- 停止中Codespaceは自動起動、環境削除はユーザー確認
- opencodeのURL/パスワードはカード表示、コピーはURL・パスワード別々
- 状態不明時は「未起動」と表示しない（稼働中の状態だけを表示）

## Progress
### Done
- Codespaces一覧・作成・停止・起動・削除（REST API、default_branchをrefに使用）
- Ona Cloud環境一覧・削除（Connect API、リダイレクト時にAuthorization再付与`onaApi()`）
- **Ona環境作成を再実装**: `POST /api/environments`に`provider:'ona'`分岐、`GET /api/ona/classes`、createダイアログにprovider選択(GitHub/Ona)+OnaのリポジトリURL/マシンクラス欄、Billingエラー時は`403 needs_subscription`+Billingリンク表示。`onaApi`はConnectエラー本文(message)を含めて投げるよう改善
- opencode起動: Codespace起動→ローカルでDL(60MB tgz→`.opencode-cache/`)→SSH stdin転送→展開→serve起動→`gh codespace ssh`トンネル→専用公開ポート配信
- 専用公開ポートは環境IDから固定(`41000+hash%10000`)、URL不変、既存トンネルは再利用
- 起動状態は`starting/running/stopped/failed`を`serveStates`で保持、`detail`で進捗表示
- 起動進捗表示（準備中/転送中/起動中/トンネル確立中）
- 各カードにOpenCode起動、停止/起動、Open workspace、削除ボタン
- `.env.local.example`に`OPENCODE_SERVER_USERNAME`と`ONA_API_HOST`を記載

### Blocked (Ona作成)
- Ona `CreateEnvironment`は**スキーマは受付る**が、組織に**アクティブなsubscription/契約がない**ため`failed_precondition`（"requires an active subscription... Settings > Billing"）で不可。実装済み・Billing開始で利用可
- `ListEnvironmentClasses`で環境クラス取得可: Small=`01a03de0-7b31-7dfc-87b2-f4cb692f5d86`(2vCPU/8GiB/50GiB)、Regular=`01a03de0-7b31-7e09-9e21-b8fb710965d8`(4vCPU/16GiB/80GiB)、runner=`01a03de0-5343-78e1-bc10-9f67c530a4b2`(Ona Cloud US01, ACTIVE)

### Vercel（現行の自己ホスト方式では不可 → 薄い制御面アーキテクチャなら可）
- **現行方式（自分のPCでトンネル/プロキシ/バイナリ転送を常駐）はVercel不可**で確定。AUPの"proxy"/"undue burden"禁止、Hobbyの個人用途限定、関数のステートレス性（microVM・read-only fs・`/tmp`上限・実行時間Hobby max 300s/Pro max 800s、Large functions 5GB、Node.js "Full coverage"）。
- **今回の調査で「Vercel=薄い制御面+Codespace内でopencode serve+公開URL」案は技術的に成立**することを確認:
  - Vercel関数は`fetch`でGitHub RESTのみ叩くなら完全ステートレス&短時間で、AUP違反にならない（プロキシ中継をしないため）。
  - Codespacesのポート公開URLは`https://<codespace>-<port>.app.github.dev`で、**Codespacesインフラが提供**（VS Codeは単なるクライアント）。`gh codespace ports`で一覧取得可、`gh codespace ports visibility <port>:public`で公開/org/privateを設定可（publicなら認証なしでアクセス可）。
  - `portsAttributes`(devcontainer.json)は標準仕様では`label/protocol/onAutoForward/requireLocalPort/elevateIfNeeded`のみで**`visibility`は無い**（GitHub仕様か要確認）。devcontainerの`forwardPorts`+`postStartCommand`/`onCreateCommand`でポート開催+opencode起動を自動化可能。
  - Vercel関数からのアウトバウンドは自由（AWS Lambdaベース、SSH port22へも可）。`gh`/`ssh`の子プロセスは**Large functions(5GB)+`includeFiles`で同梱すれば可**。実行時間は「serve起動を投げて即返す」だけなら数秒で収まる。
  - **重要: ヘッドレス（API/CLI作成・エディタ未接続）Codespaceでは`*.app.github.dev`のポート転送が未初期化の可能性**（READMEの既存指摘）。→ 解決策: devcontainerに`forwardPorts`+`portsAttributes`+`postCreateCommand`(opencode DL+起動)を仕込み、Vercel側はRESTでcreate/startだけ制御し、公開URLは既知の形式`https://<cs>--4096.app.github.dev`を返す。SSHを一切使わないのでgh/ssh同梱不要。
  - **Vercel化の現実的な選択肢**: (A) devcontainer自己構成+全SSH廃止(最軽量/RESTのみ), (B) `gh`をLarge functionに同梱しSSH exec（現行コードの移植に近いが重い）。READMEの「Vercel不可」記述は現行自己ホスト方式に限定して維持。

### Research (Ona新製品 = Gitpod Flexベース)
- APIはConnect RPC、`{host}/api/gitpod.v1.<Service>/<Method>`。トークンのissは`app.gitpod.io`。`onaApi()`(server.js)は308リダイレクトにAuthorization再付与で追従（app.ona.com→app.gitpod.io）
- **CreateEnvironmentのスキーマ**: `{spec:{specVersion:"1", machine:{class:"<環境クラスUUID>"}, content:{initializer:{specs:[{contextUrl:{url:"<gitURL>"}}]}}}, name?}`（`EnvironmentSpec`）。`machine.class`は`ListEnvironmentClasses`の`environmentClasses[].id`(UUID)
- マシンクラス列挙: `EnvironmentService/ListEnvironmentClasses`。Runner列挙: `RunnerService/ListRunners`
- **ont問わず実行方法**: `ona environment exec <id> -- <cmmd>`(EnvironmentOps API, SSH不要) / `ona environment ssh <id> -- <cmmd>`。環境は**起動中**であること。リポジトリ非依存でopencode起動可
- 現状: opencode serveはCodespaces専用(`/api/opencode/*` はgithub依存)。Onaのopencode起動は未実装（実装判断保留）

### 無料枠の結論 (Ona公式 pricing, 2026-08確認)
- **Ona新製品に無料枠は存在しない**。公式Pricingは **Core $20/月〜** と **Enterprise(カスタム)** の2プランのみ。Hobby/Free範疇なし、トライアルの記載なし。OCU制（80〜2200込み、追加$10/40 OCU）。Coreは100人まで/並列無制限/32vCPU・128G・200Gディスク/GPU対応。
- → 「無料枠があるはず」は**旧Gitpodの無料プラン**（現行Ona=Gitpodの後継・`*.gitpod.io`管理プレーン）との混同。サインアップ時のorgは契約無しで作られるため、List/Create等のスキーマ検証は通るが、実プロビジョニングに契約が必要（APIの`failed_precondition`「requires an active subscription」はこのため）。
- **$20/月を払わない限りOnaで環境作成は不可**。以後のOna作成サポートはBilling有効化が前提。

## Key Decisions
- npmを使わずopencodeバイナリをGitHub ReleasesからローカルDLしSSH stdinで転送（CodespaceのNVSがnpmを壊すため）
- `/oc/<env>`サブパスではなく専用ポートのルート配信（SPAアセット・WebSocketが正しく動くため）
- トンネルはループバックに張り、Cloud Deckのnode.exeが0.0.0.0にバインド（ファイアウォール内包）
- SSHコマンドは複数引数（`mkdir`/`cat`等）でリトライ付き

## Relevant Files
- `cloud-deck/server.js`: 全サーバーロジック（GitHub/Ona API、opencode起動、プロキシ、トンネル）
- `cloud-deck/public/app.js`: カードUI、状態ポーリング(5s)、ボタン操作
- `cloud-deck/public/index.html` / `public/style.css`: UI
- `cloud-deck/.env.local.example`: 環境変数テンプレート（`.env.local`/`.opencode-cache/`はgitignore対象）
- `cloud-deck/.opencode-cache/`: opencodeバイナリ用ローカルキャッシュ
