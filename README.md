# Kozmik Cloud Dashboard

GitHub Codespaces の開発環境をスマホから管理するためのWebアプリです。モックは表示せず、設定済みプロバイダーの実データだけを表示します。

> **OpenCodeはCodespace内で自己ホストします。** ダッシュボードの「OpenCode起動」ボタンでは、対象のCodespaceを GitHub REST API で起動し、Codespaces標準のポート転送URL（`https://<codespace>-4096.app.github.dev`）を表示します。`opencode` 本体は Codespace 内の `.devcontainer`（`postStartCommand`）によって自動インストール・常駐起動されるため、ダッシュボード側に `gh` CLI や SSH トンネル、バイナリ転送は一切不要です。ローカルでもVercel上でも同一の動作です。

## 使い方

1. `.env.local` を作成

```powershell
Copy-Item .env.local.example .env.local
```

2. トークンを設定（値はブラウザに返しません）

```env
GITHUB_CODESPACES_TOKEN=github_pat_...
DASHBOARD_PASSWORD=your-secret-password
```

3. 起動

```powershell
npm start
```

4. `http://localhost:3000` を開く
   - 未設定なら「環境がありません」と表示され、必要な設定が案内されます
   - 設定済みなら `GET /api/environments` の実データが一覧に表示されます
   - 各Codespaceの「OpenCode起動」で、そのCodespaceを **Codespacesの公開URL（`https://<codespace>-4096.app.github.dev`）** からブラウザで開きます

スマホの場合は、PCと同じWi-Fiで `http://<PCのIP>:3000` を開いてください。`DASHBOARD_PASSWORD` を設定している場合は `/login.html` でパスワードログインが必要です。

## OpenCodeを利用するための準備（Codespace側・初回のみ）

OpenCodeはCodespace内で動作するため、対象リポジトリに `.devcontainer` が必要です。本リポジトリの `.devcontainer/` を参考（またはそのままコピー）にしてください。

`.devcontainer/devcontainer.json` に含まれる内容:

- `"build.dockerfile": ".devcontainer/Dockerfile"` — **軽量な自前イメージ**（`debian:12-slim` ＋ curl/git/tar/sed/grep/util-linux ＋ opencode をビルド時にプリインストール）。旧 `universal:2`（数GB）に比べて**初回起動が大幅に高速**です。
- `"forwardPorts": [4096]` — opencodeが使うポートを転送
- `"portsAttributes"` — ポート4096の転送設定。`visibility` は **public**（`https://<codespace>-4096.app.github.dev` をログインなしで開ける）かつ opencode を **Basic 認証（`opencode` / パスワード）** で保護しています。
- `"hostRequirements"` — 高速なマシン指定（cpus4/memory8gb/storage16gb）
- `"postStartCommand"` — Codespace 起動のたびに `start-opencode.sh`（**有限のランチャー**）が（1）Basic認証パスワードを用意し、（2）`config-opencode` の設定を `~/.config/opencode` へ反映、（3）`start-opencode-daemon.sh`（`opencode web --hostname 0.0.0.0 --port 4096` の常駐監視・クラッシュ時自動再起動）と `presence-monitor.sh`（自動停止モニター）を **`setsid` で分離起動して即座に終了**する。※GitHub Codespaces は `postStartCommand` が終了するまで起動(Provisioning)が完了しないため、ランチャーを無限ループにしないことが必須

**手順:**

1. 対象リポジトリに `.devcontainer/`（`devcontainer.json`・`Dockerfile`・各 `.sh`）を追加してコミット
2. Codespacesでリポジトリを開いて **「Rebuild Container（コンテナーの再ビルド）」** を実行する（追加済みのCodespaceには再ビルド前に反映されません）
3. `postStartCommand` により opencode がポート4096で起動し、`https://<codespace>-4096.app.github.dev` でアクセスできます（Basic認証ダイアログでユーザー名 `opencode` とパスワードを入力）

### ポート公開（public）と Basic 認証

- ポート4096は **public**（ログイン不要でURLを開ける）＋ opencode の **Basic 認証**で保護しています。ユーザー名は既定 `opencode`。
- パスワードは Codespaces シークレット **`OPENCODE_SERVER_PASSWORD`** で設定します（未設定時は初回起動時にランダム生成され `~/.config/opencode/.webpass` に保存、再起動でも同じ値）。
- この Basic 認証の値は `presence-monitor.sh`（セッション監視）が opencode サーバーへの問い合わせにも使います。
- 組織ポリシーで public ポートが無効な場合は、`portsAttributes."4096".visibility` を `"private"` に変更して GitHub ログイン経由で利用してください。

### ヘッドレス（エディタ未接続）Codespaceの注意

API/CLIで作成して一度もエディタを開いていないCodespaceでは、ポート転送エージェント（`*.app.github.dev` の配信）が有効になるまで数十秒ほどかかる場合があります。「開く ↗」して読み込み中になる場合は、少し待って再読み込みしてください。それでも表示されない場合は、一度ブラウザからCodespaceのUI（`https://github.com/codespaces`）を開いてから再度やってみてください。

## 認証について

`DASHBOARD_PASSWORD` を設定すると、すべてのページ・APIがパスワード保護されます。`/login.html` でログインすると `kcd_auth` Cookie（HttpOnly, 30日）が発行され、未認証のAPIは `401 unauthorized` を返し、ページは `/login.html` にリダイレクトされます。Vercelでは環境変数 `DASHBOARD_PASSWORD` で同様に保護されます。

## 監視中スイッチと自動停止

就寝・勤務・外出などでダッシュボードを開けない時間に、Codespace を無駄に起動し続けないための仕組みです。

- **監視中スイッチ**: サイドバーの「MONITORING」スイッチで「監視中(ON)/不在(OFF)」を切り替えます。状態は `GITHUB_PRESENCE_TOKEN` で GitHub の `opencode-workspace` リポジトリの `presence` ブランチ（`presence.json`）に保存されます。在席⇄離席の切り替えは頻繁に起きる「状態」のため、`main` ブランチの履歴を汚染しないよう専用ブランチに置いています。
- **自動停止モニター**: Codespace 内で `presence-monitor.sh` が常駐し、以下を満たすと Codespace を自動停止します。
  1. スイッチが **不在(OFF)** である
  2. opencode の全セッションが完了している（`/session/status` に `"busy"` が1つも無い）
  3. 上記の状態が猶予時間（既定180秒）継続した

エージェントが動作中（busy）の間は停止しません。また、`start-opencode.sh` が `config-opencode`（GitLab）の追跡ファイルのみを `~/.config/opencode` へ反映するため、opencode が生成する `node_modules` 等と競合せず、ローカルと同一のスキル・設定が Codespace 上でも使えます。

### 必要な準備

- ダッシュボード側: `GITHUB_PRESENCE_TOKEN`（`opencode-workspace` リポジトリの Contents 読み書き権限。classic PAT なら `repo`、fine-grained なら Contents: Read and write）を設定。保存先は既定で `Densyakun/opencode-workspace` の `presence` ブランチ（`GITHUB_PRESENCE_REPO` / `GITHUB_PRESENCE_BRANCH` で変更可）。
- Codespace 側: 監視スイッチの読み取りは Codespaces 自動注入の `GITHUB_TOKEN` で行うため、監視専用の追加シークレットは不要です。config 同期（private リポジトリの clone）には従来どおり `GITLAB_TOKEN`（または `PRESENCE_GITLAB_TOKEN` からのフォールバック）を使います。
  - シークレットは新しい Codespace 作成時または再起動時に反映されます。
- （任意）Codespaces シークレット **`OPENCODE_SERVER_PASSWORD`** で opencode Web の Basic 認証パスワードを固定できます。未設定時は初回起動にランダム生成され `~/.config/opencode/.webpass` に保持されます。
- 対象リポジトリの `.devcontainer/` に `start-opencode.sh`・`presence-monitor.sh` を含める（本リポジトリを参考にコピー）。`devcontainer.json` の `postStartCommand` がこれらを実行します。
- `config-opencode` は **private リポジトリ**のため、Codespace 内からの `git clone` には認証トークンが必要です。`GITLAB_TOKEN`（未設定時は `PRESENCE_GITLAB_TOKEN` からのフォールバック）を config 同期に使います。監視スイッチの読み取りには使いません。
- GitHub Codespaces の **Default idle timeout は上限の240分（4時間）に設定**してください。エージェント稼働中はターミナル出力により idle がリセットされるため停止せず、完了後は最長4時間で Codespace 側タイムアウトがバックアップとして働きます。

## API接続について

Personal access tokenはサーバー側でのみ読み込み、ブラウザへ返しません。`/api/status` と `/api/config` は現在の設定状態のみ返します。

`GET /api/environments` は設定済みのCodespacesから環境を取得します。GitHub Codespacesについては公式REST APIを利用し、一覧・作成・起動・停止・削除に対応しています。

`POST /api/environments` はリポジトリID/refでCodespacesを作成します。

`POST /api/opencode/serve` は、GitHub REST API で対象Codespaceを起動します（停止中なら `POST /user/codespaces/{name}/start` を呼び出し、起動中・稼働中なら何もしません）。状態はすぐには反映されないため、フロントエンドは `GET /api/opencode/status?ids=<コードスペース名のカンマ区切り>` を5秒間隔でポーリングします。

## Vercelへのデプロイについて

**本リポジトリはVercelデプロイに対応しており、OpenCode起動を含む全機能がローカルと同一で利用できます。**

```powershell
vercel --prod
# Vercelダッシュボードで以下を設定: GITHUB_CODESPACES_TOKEN, DASHBOARD_PASSWORD（任意）
```

- `/api/*` は `api/` 配下のVercel Functionsで処理されます（`server.js` はローカル実行用です）
- Vercel上でも「OpenCode起動」は動作します。関数はステートレスのため状態は保持しませんが、起動は REST API（1回のPOST）で完結し、状態はCodespaces側のstateを毎回参照するため、どこから呼んでも同じ結果になります
- opencode本体はVercelではなく**Codespace内**で起動するため、Vercelは「薄い制御面（control plane）」のままです

### Vercelで排出されるリスクと対策

従来の「Vercel関数がSSHトンネルを張ってopencodeを配信する」方式は、Vercelの実行時間制限（Hobby最大300s）とAcceptable Use Policy（長期接続のプロキシ用途の禁止）から成立しません。本方式はVercelにプロキシ・トンネルを張らず、公開リレーはGitHub Codespacesのポート転送インフラ（`*.app.github.dev`）に委ねています。

## 必要環境（サーバー側）

- Node.js 18以上（fetch利用のため）。`gh` CLIは不要になりました

## 注意点

- Codespacesの公開URL（`https://<codespace>-4096.app.github.dev`）は、ポートが**privateの場合はGitHubログイン済みブラウザのみ**、**public設定後は誰でも**アクセスできます。publicにする場合は必ずopencodeにBasic認証（`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`）を設定してください
- `.devcontainer` の変更（`forwardPorts` / `portsAttributes` / `postStartCommand` など）は **Rebuild Container** で初めて反映されます
- `opencode` 本体は公式インストーラ（https://opencode.ai/install）から最新版（`anomalyco/opencode`）を自動取得します
- 認証情報（GITHUB/PAT）はサーバー側でのみ保持し、ブラウザには返しません

実装済みのCodespacesアダプターはPersonal access tokenを使って以下を行います。

1. Codespaces APIで対象環境を特定し、停止中なら `POST /user/codespaces/{name}/start` で非同期起動
2. `GET /user/codespaces/{name}` の state をポーリングし、Runningなら `https://<codespace>-4096.app.github.dev` を公開URLとして返却
3. URLはカード上で「開く ↗」「URLをコピー」として表示（起動待ち中は「起動中…」、失敗時はエラー表示）

OpenCode起動はGitHub Codespacesに対応しています。公開URLへのアクセス可否はCodespace側のポート可視性設定（private/public）に依存するため、上記「ポート公開（public）について」を確認してください。