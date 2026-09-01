# Kozmik Cloud Dashboard

GitHub Codespaces と Ona Cloud の開発環境をスマホから管理するためのWebアプリです。モックは表示せず、設定済みプロバイダーの実データだけを表示します。

> **Codespaces側の操作不要** — ダッシュボードの「OpenCode起動」ボタンだけで、停止中Codespaceの自動起動・opencodeバイナリの転送・`opencode serve`の起動・トンネル確立までを全自動で行います。Codespace内でターミナルを開いたりコマンドを打つ必要はありません。

## 使い方

1. `.env.local` を作成

```powershell
Copy-Item .env.local.example .env.local
```

2. トークンを設定（値はブラウザに返しません）

```env
GITHUB_CODESPACES_TOKEN=github_pat_...
ONA_PERSONAL_ACCESS_TOKEN=...
OPENCODE_API_KEY=...
DASHBOARD_PASSWORD=your-secret-password
```

3. 起動

```powershell
npm start
```

4. `http://localhost:3000` を開く
   - 未設定なら「環境がありません」と表示され、必要な設定が案内されます
   - 設定済みなら `GET /api/environments` の実データが一覧に表示されます
   - 各Codespaceの「OpenCode起動」で、そのCodespace内に `opencode serve` を起動して**専用の固定URL・ユーザー名・パスワード**を取得します（要 `gh` CLI）

スマホの場合は、PCと同じWi-Fiで `http://<PCのIP>:3000` を開いてください。`DASHBOARD_PASSWORD` を設定している場合は `/login.html` でパスワードログインが必要です。

## 認証について

`DASHBOARD_PASSWORD` を設定すると、すべてのページ・APIがパスワード保護されます。`/login.html` でログインすると `kcd_auth` Cookie（HttpOnly, 30日）が発行され、未認証のAPIは `401 unauthorized` を返し、ページは `/login.html` にリダイレクトされます。Vercelでは環境変数 `DASHBOARD_PASSWORD` で同様に保護されます。

## API接続について

Personal access tokenはサーバー側でのみ読み込み、ブラウザへ返しません。`/api/status` と `/api/config` は現在の設定状態のみ返します。

`GET /api/environments` は設定済みのCodespacesとOna Cloudから環境を取得します。GitHub Codespacesについては公式REST APIを利用し、一覧・作成・起動・停止・削除に対応しています。Ona Cloudは公式Connect APIの`ListEnvironments`を利用します。

`POST /api/environments` は`provider`に従って環境を作成します。`github`はリポジトリID/refでCodespacesを作成、`ona`はリポジトリURLとマシンクラスUUIDで`EnvironmentService/CreateEnvironment`を呼び出します。`GET /api/ona/classes` はOna側の利用可能なマシンクラス一覧を返します。

`POST /api/opencode/serve` は、選択したGitHub Codespacesに対してSSHで接続し、Codespace内に`opencode`を転送した上で`opencode serve`を起動し、`gh codespace ssh -L`のトンネルを確立します。

### OpenCodeの公開について

**Codespaces上で手動操作は不要です。** ダッシュボードからワンクリックで `opencode serve` が起動し、Codespace内でのコマンド入力やVS Code操作は必要ありません。

Kozmik Cloud Dashboardは環境ごとに**固定の専用公開ポート**を開設し、`http://<サーバーのLAN IP>:<専用ポート>/`としてopencodeをルート配信します（SPA・WebSocketもそのまま動作し、パスワード認証でログインできます）。トンネルはループバックに張り、Kozmik Cloud Dashboardプロセスが0.0.0.0にバインドするため、同じネットワークのスマホから開けます。

- 専用ポートは環境IDから固定で決まるため、**URLは起動のたびに変わりません**
- 認証はBasic認証で、ユーザー名`OPENCODE_SERVER_USERNAME`（既定`opencode`）とパスワード`OPENCODE_SERVER_PASSWORD`（未設定なら毎回ランダム生成）を使用します
- URLとパスワードはカード上でそれぞれ**個別にコピー**できます（未起動時は「未起動」と表示せず、稼働中の状態だけを表示します）
- 停止中Codespaceは自動で起動した上でOpenCodeを起動します（Codespace側での操作不要）。環境削除には確認ダイアログが必要です

### Ona Cloudの環境作成について

Ona Cloudでは、Connect APIの`EnvironmentService/CreateEnvironment`で環境を作成できます。作成には**環境クラス（マシンクラス）UUID**と**リポジトリURL**が必要で（`spec.machine.class` / `spec.content.initializer.specs[].contextUrl.url`）、一覧から環境クラスを取得して送信します。

ただし、**Ona新製品には無料枠がありません**（公式PricingはCore 約$20/月〜 とEnterpriseのみ。OCU制）。このアカウントの組織には**アクティブな契約（subscription）がないため**、現状はAPIが`failed_precondition`（"your organization requires an active subscription... Settings > Billing"）を返し、**環境の作成はできません**。実装はされていますが、Onaコンソールの「Settings > Billing」でCore等の契約を開始すると利用できます。「無料枠があるはず」というのは旧Gitpodの無料プランとの混同です。一覧・削除は契約に関係なくAPIで行えます。

Ona製品のAPIドメインは組織ごとに異なる場合があります（例: `https://app.ona.com`、`app.gitpod.io`）。`app.ona.com` は308リダイレクトで実際の管理プレーンへ転送され、アプリは認証を再付与して追従します。ホストは`.env.local`の`ONA_API_HOST`で上書きできます（既定`https://app.ona.com`）。

### Vercelへのデプロイについて

**本リポジトリはVercelデプロイに対応しています（薄い制御面アーキテクチャ）。**

```powershell
vercel --prod
# Vercelダッシュボードで以下を設定: GITHUB_CODESPACES_TOKEN, ONA_PERSONAL_ACCESS_TOKEN（OpenCodeの起動をVercelで行わないため OPENCODE_API_KEY は任意）
```

- Vercelはプロジェクトを自動検出し、本リポジトリでは `server.js`（Node.js）を**1つのサーバーレス関数**としてデプロイします。`api/` 配下のFunctions・`public/` の静的配信に切り替えたい場合は、Vercelプロジェクト設定のFramework Presetを「Other」に変更してください。
- GitHub Codespaces/Ona Cloud の**一覧・作成・起動・停止・削除（薄い制御面）はVercel上でも利用できます**。
- Vercel上では `POST /api/opencode/serve` は **`501 not_available_on_vercel`** を返します（サーバーレス関数はステートレスのため、SSHトンネル・固定公開ポート・バイナリ転送を保持できません）。UIでも「OpenCode起動」ボタンは非表示になり、案内が表示されます。
- Codespacesに `opencode serve` を起動して専用URLで使う**フル機能は、ローカルで `node server.js`**（`gh` CLI必要）を実行してください。
- Vercel上でOpenCodeを利用したい場合の代替案: 対象リポジトリの `.devcontainer/` に `forwardPorts` / `portsAttributes` と `onCreateCommand`/`postStartCommand`（opencodeの取得・起動）を設定してCodespacesへデプロイし、`gh codespace ports visibility 4096:public` で公開した Codespaces公開URL（`https://<codespace>-4096.app.github.dev`）経由でアクセスします。

<details>
<summary>なぜ従来の自己ホスト方式はVercelで動作しないか</summary>

- **技術的な理由**: Vercel Functionsはステートレスなサーバーレス実行環境（microVM・Read-only FS・`/tmp`上限・Hobby最大300s/Pro最大800s）で、長時間動作するHTTPサーバー・SSHトンネル・固定公開ポートの`0.0.0.0`バインド・永続キャッシュを保持できません。
- **ポリシー上の理由**: VercelのAcceptable Use Policyは長期の接続を中継するプロキシ／トンネル用途（"proxy", "act as a VPN", "undue burden"）やHobbyプランの商用利用を禁止しており、本アプリの現行運転形態（リモート開発環境へのトンネル・プロキシ配信）は許容されません。

**ただし、アーキテクチャを変えれば「薄い制御面（control plane）のホスティング」としてはVercelで成立させられます。** Vercelにはプロキシを張らず、以下の役割だけを持たせます。

1. **Vercel = 制御面のみ（ステートレス）**: 静的フロントエンド＋`fetch`によるGitHub Codespaces REST API（一覧・作成・起動・停止・削除）への呼び出しだけを行い、プロキシ・トンネル・バイナリ転送は行いません（AUP違反にならず、実行時間も数秒に収まります）。
2. **実際の`opencode serve`はCodespace内で self-host する**: 対象リポジトリに`.devcontainer/`を用意し、`forwardPorts`＋`portsAttributes`でポート4096を転送し、`onCreateCommand`/`postStartCommand`でopencodeを取得・起動します。`opencode serve`がHTTPS未対応のため、必要に応じてCodespace内でTLS終端するか、`--hostname 0.0.0.0`でHTTPのまま公開します。
3. **公開URLはCodespacesの標準形式 `https://<codespace>-<port>.app.github.dev`**: Codespacesインフラがステートレス制御面の代わりに公開リレーを持ちます。`gh codespace ports`で一覧・`gh codespace ports visibility <port>:public`で公開設定が可能です。公開局面では認証をopencodeのBasic認証（`OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`）で行います。
4. **成果物をVercelから直接 exec する場合**: どうしてもVercel関数からSSHでCodespaceへコマンドを投げるなら、`gh`/`ssh`を**Large functions（上限5GB・`includeFiles`）に同梱**し、Vercelの自由なアウトバウンド（port 22も可）を使って起動だけ投げ、即返す形なら技術的には可能です（ただし同梱分のデプロイサイズ増と要検証）。

未検証の注意点として、**ヘッドレス（API/CLIで作成しエディタ未接続）のCodespaceでは`*.app.github.dev`のポート転送エージェントが未初期化で、ポートが公開されない可能性があります。** その場合は（a）`.devcontainer`で`forwardPorts`を宣言して公開する、または（b）Codespace内で逆トンネルを張る、のどちらかで回避します。実際にデプロイする前に、小さいdevcontainerでこの動作確認を行うのが安全です。

</details>

現行のローカル実行方式は引き続き`node server.js`で利用できます。公開時はTLS・アクセス制御を追加してください。

## 必要環境（サーバー側）

- Node.js 18以上
- GitHub CLI（`gh`）。未導入なら以下でインストールしてください。

```powershell
winget install --id GitHub.cli -e --scope user
```

- `gh` は`winget`のLinks/Packagesフォルダから自動検出します（`GH_PATH`環境変数でも指定可能）。

## 注意点

- Codespacesの「公開ポートURL（`https://<codespace>-<port>.app.github.dev`）」は、ヘッドレス（API/CLIで作成しエディタ未接続）のCodespaceでは転送エージェント未初期化のため表示できない場合があります。現行のKozmik Cloud Dashboardはそれを避けるため、SSHトンネル経由のURL（LAN内）を表示します。Vercel化する場合、このヘッドレス条件でポートが公開されるかを先に小さいdevcontainerで検証してください。
- OpenCode serveのパスワード（`OPENCODE_SERVER_PASSWORD`）は未設定なら毎回ランダム生成され、レスポンスに含めます。
- 認証情報（GITHUB/PAT）はサーバー側でのみ保持し、ブラウザには返しません。

実装済みのCodespacesアダプターはPersonal access tokenを使って以下を行います。

1. Codespaces APIで対象環境を特定し、停止中なら自動起動
2. `gh codespace ssh`で対象環境へ接続（opencodeバイナリは初回のみSSH経由で転送）
3. `OPENCODE_API_KEY` と強力なパスワードを環境変数へ渡して `opencode serve` を起動
4. `gh codespace ssh -L`でトンネルを張り、環境ごとの固定専用ポートでLAN公開URLを生成
5. URL・ユーザー名・パスワードを画面に表示（各カードで個別コピー可能）

`gh` CLIがサーバー上に必要です。OpenCode起動は現在GitHub Codespacesに対応しています（Ona Cloudは一覧・削除のみ）。公開URLとパスワードはLAN内の本人利用を想定しており、パブリック公開する場合は追加のTLS・アクセス制御を必ず検討してください。
