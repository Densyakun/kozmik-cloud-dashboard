import crypto from 'node:crypto';

// opencode は Codespace 側（.devcontainer の postStartCommand）でポート4096に常駐させる。
// ダッシュボードは GitHub REST API で起動/状態確認だけを行い、公開URLを表示する。
const OPENCODE_PORT = 4096;

export function codespaceForwardUrl(name) {
  return `https://${name}-${OPENCODE_PORT}.app.github.dev`;
}

// OpenCode のBasic認証情報。Codespace内の .devcontainer と同一のデフォルトにし、環境変数で上書きできる。
// 実運用では公開URLを知る全員がこの認証情報でログインできるため、必ず変更すること。
export function opencodeCredentials(env = process.env) {
  return {
    username: env.OPENCODE_SERVER_USERNAME || 'opencode',
    password: env.OPENCODE_SERVER_PASSWORD || 'c2691c2fefc33ee30e117c27',
  };
}

// Codespaceの公開URLに /global/health をリクエストし、opencode が実際に応答するかを確認する。
// 応答しない場合: healthy=false, httpCode=0 (接続不可/タイムアウト) または応答のHTTPコードを返す。
export async function probeOpenCodeHealth(publicUrl, { env = process.env, timeoutMs = 4000 } = {}) {
  if (!publicUrl) return { healthy: false, httpCode: 0 };
  const { username, password } = opencodeCredentials(env);
  const baseUrl = String(publicUrl).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/global/health`, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
    });
    // private転送に戻っている場合、*.app.github.dev は GitHub のサインイン（pf-signin）へ
    // リダイレクトする。最終URLがオリジンの公開URLと異なれば「トンネル層の応答」として区別する。
    const finalUrl = String(res.url || '');
    const tunnelRedirect = !finalUrl.startsWith(baseUrl);
    if (!res.ok || tunnelRedirect) return { healthy: false, httpCode: res.status, tunnelRedirect };
    const body = await res.json();
    return { healthy: Boolean(body && body.healthy), version: body && body.version, httpCode: res.status };
  } catch {
    return { healthy: false, httpCode: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// opencode が未応答のときの表示文言。
// トンネル層の応答（404/5xx/pf-signinへのリダイレクト）は opencode ではなく
// Codespaces のポート転送の公開設定が外れている可能性が高いため、対処コマンドを案内する。
export function opencodeErrorDetail(httpCode, { environmentId, port = OPENCODE_PORT } = {}) {
  if (httpCode === 404 || httpCode === 403 || httpCode === 502 || (httpCode && httpCode >= 500)) {
    return `opencodeが未応答です（HTTP ${httpCode}）。Codespacesのポート転送（トンネル）が公開設定から外れている可能性があります。数分待って再読み込みするか、ターミナルで「gh codespace ports visibility ${port}:public -c ${environmentId}」を実行してから再読み込みしてください。`;
  }
  return `opencodeが未応答です（HTTP ${httpCode || 0}）。しばらく待ってから再読み込みしてください。`;
}

// GitHub Codespaces の state をダッシュボード用の分類に変換する
export function describeCodespaceState(state) {
  const st = String(state || '').toLowerCase();
  if (/avail|run|active/.test(st)) return { kind: 'running' };
  if (/start|provisio|created|queue|prepar|boot/.test(st)) return { kind: 'starting' };
  if (/stopp|shut|archiv/.test(st)) return { kind: 'stopped' };
  if (/fail|deleted|unknown/.test(st)) return { kind: 'failed' };
  return { kind: 'starting' };
}

export function getProviders() {
  return {
    codespaces: Boolean(process.env.GITHUB_CODESPACES_TOKEN),
    opencode: Boolean(process.env.OPENCODE_API_KEY),
  };
}
export function getDashboardPassword() {
  return process.env.DASHBOARD_PASSWORD || process.env.KOZMIK_DASHBOARD_PASSWORD || '';
}
export function getDashboardToken() {
  const pw = getDashboardPassword();
  return pw ? crypto.createHash('sha256').update(pw).digest('hex') : '';
}
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) { const [k, ...v] = part.trim().split('='); if (k) out[k.trim()] = decodeURIComponent(v.join('=')); }
  return out;
}
export function isAuthenticated(req) {
  const pw = getDashboardPassword();
  if (!pw) return true;
  const cookies = parseCookies(req.headers?.cookie || '');
  return cookies.kcd_auth === getDashboardToken();
}
export function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
  const isApi = req.url?.startsWith('/api/');
  if (isApi) { res.status(401).json({ message: '認証が必要です', code: 'unauthorized' }); return false; }
  res.writeHead?.(302, { Location: '/login.html' });
  if (res.redirect) res.redirect('/login.html');
  return false;
}

export async function github(pathname, options = {}) {
  const token = process.env.GITHUB_CODESPACES_TOKEN;
  if (!token) throw Object.assign(new Error('GITHUB_CODESPACES_TOKEN が設定されていません'), { status: 400 });
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = `GitHub API ${res.status}`;
    try { const body = await res.json(); detail = `${detail}: ${body.message || JSON.stringify(body)}`; } catch {}
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export function normalizeGithub(item) {
  return { id: item.name, name: item.display_name || item.name, provider: 'GitHub Codespaces', providerId: 'github', state: item.state, branch: item.git_status?.ref || 'main', repository: item.repository?.full_name || '-', url: item.web_url, updatedAt: item.updated_at };
}

// ---------------------------------------------------------------------------
// Presence（監視中スイッチ）: ダッシュボードと Codespace 内 opencode の間で共有する状態。
//
// 在席⇄離席の切り替えは頻繁に起きる「状態」であり main ブランチの履歴を汚染
// しないよう、状態は GitHub の opencode-workspace リポジトリの専用ブランチ
// `presence` に置く `presence.json` に保持する。ダッシュボードは
// GITHUB_PRESENCE_TOKEN で書き込み、Codespace は自前の監視ループで
// raw.githubusercontent.com から読み取る。
// ---------------------------------------------------------------------------
export function getPresenceToken() {
  return process.env.GITHUB_PRESENCE_TOKEN || process.env.GITHUB_TOKEN || '';
}
export function getPresenceRepo() {
  return process.env.GITHUB_PRESENCE_REPO || 'Densyakun/opencode-workspace';
}
export function getPresenceBranch() {
  return process.env.GITHUB_PRESENCE_BRANCH || 'presence';
}
export const PRESENCE_PATH = 'presence.json';

export async function presenceGithubApi(pathname, options = {}) {
  const token = getPresenceToken();
  if (!token) throw Object.assign(new Error('GITHUB_PRESENCE_TOKEN が設定されていません'), { status: 400 });
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = `GitHub API ${res.status}`;
    try { const body = await res.json(); detail = `${detail}: ${body.message || JSON.stringify(body)}`; } catch {}
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

// 現在の presence（監視中か否か）を GitHub の presence ブランチから取得する。
export async function readPresence() {
  const token = getPresenceToken();
  if (!token) return { monitoring: true };
  const repo = getPresenceRepo();
  const branch = getPresenceBranch();
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${PRESENCE_PATH}?ref=${encodeURIComponent(branch)}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { monitoring: true };
  if (!res.ok) {
    let detail = `GitHub API ${res.status}`;
    try { const body = await res.json(); detail = `${detail}: ${body.message || JSON.stringify(body)}`; } catch {}
    throw Object.assign(new Error(detail), { status: res.status });
  }
  const data = await res.json();
  const text = Buffer.from(String(data.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  return parsePresence(text);
}

function parsePresence(text) {
  try {
    const parsed = JSON.parse(String(text));
    return { monitoring: parsed?.monitoring !== false, updatedAt: parsed?.updatedAt || null };
  } catch {
    return { monitoring: true };
  }
}

// presence を GitHub の presence ブランチに書き込む。既存ファイルの sha を
// 取得して PUT で更新し、存在しなければ sha 無しで新規作成する。
export async function writePresence(monitoring) {
  const repo = getPresenceRepo();
  const branch = getPresenceBranch();
  const payload = JSON.stringify({ monitoring: Boolean(monitoring), updatedAt: new Date().toISOString() }, null, 2);
  const content = Buffer.from(payload).toString('base64');
  let sha;
  try {
    const current = await presenceGithubApi(`/repos/${repo}/contents/${PRESENCE_PATH}?ref=${encodeURIComponent(branch)}`);
    sha = current?.sha;
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  await presenceGithubApi(`/repos/${repo}/contents/${PRESENCE_PATH}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `chore: presence ${monitoring ? 'on' : 'off'}`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  return { monitoring: Boolean(monitoring) };
}

// ---------------------------------------------------------------------------
// Codespace 内 opencode のセッション状態をヘルスチェック的に読み、全セッションが
// 完了（busy でない）かどうか判定する。Codespace 側の監視ループはこれと同等の
// ロジックをローカル(localhost)に対して実行する。
// SessionStatus: { type: "idle" } | { type: "retry" } | { type: "busy" }
// "busy" が1つでもあれば「エージェント稼働中」とみなす。
// ---------------------------------------------------------------------------
export function describeSessionStatuses(statuses) {
  const entries = Object.values(statuses || {});
  const busy = entries.filter((s) => s?.type === 'busy');
  return { total: entries.length, busy: busy.length, allDone: busy.length === 0 };
}

export function json(res, status, body) {
  res.status(status).json(body);
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
