import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { opencodeCredentials, probeOpenCodeHealth, opencodeErrorDetail } from './api/_lib/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// opencode は Codespace 側（.devcontainer の postStartCommand）でポート4096に常駐させる。
// ダッシュボードは GitHub REST API で起動/状態確認だけを行い、公開URLを表示する。
const OPENCODE_PORT = 4096;
const OPENCODE_APP_GITHUB_DEV = '.app.github.dev';

function codespaceForwardUrl(name) {
  return `https://${name}-${OPENCODE_PORT}${OPENCODE_APP_GITHUB_DEV}`;
}

// GitHub Codespaces の state をダッシュボード用の分類に変換する
function describeCodespaceState(state) {
  const st = String(state || '').toLowerCase();
  if (/avail|run|active/.test(st)) return { kind: 'running' };
  if (/start|provisio|created|queue|prepar|boot/.test(st)) return { kind: 'starting' };
  if (/stopp|shut|archiv/.test(st)) return { kind: 'stopped' };
  if (/fail|deleted|unknown/.test(st)) return { kind: 'failed' };
  return { kind: 'starting' };
}

async function startCodespaceIfNeeded(environmentId) {
  const codespace = await github(`/user/codespaces/${encodeURIComponent(environmentId)}`);
  const { kind } = describeCodespaceState(codespace.state);
  if (kind === 'stopped') {
    // start API は非同期。完了（Running）は1〜2分後なので、フロントエンドのポーリングで状態遷移を監視する
    await github(`/user/codespaces/${encodeURIComponent(environmentId)}/start`, { method: 'POST' });
  }
  return codespace;
}

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, '.env.local');
const env = {};
if (existsSync(envPath)) {
  const text = await readFile(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
Object.assign(env, process.env);

const isVercel = Boolean(process.env.VERCEL);

const serverPort = Number(env.PORT || 3000);
const providers = {
  codespaces: Boolean(env.GITHUB_CODESPACES_TOKEN),
  // opencode は Codespace 内で自己ホストするためダッシュボード側の設定は任意
  opencode: Boolean(env.OPENCODE_API_KEY),
};
const dashboardPassword = env.DASHBOARD_PASSWORD || env.KOZMIK_DASHBOARD_PASSWORD || '';
const dashboardToken = dashboardPassword ? crypto.createHash('sha256').update(dashboardPassword).digest('hex') : '';
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) { const [k, ...v] = part.trim().split('='); if (k) out[k] = decodeURIComponent(v.join('=')); }
  return out;
}
function isAuthenticated(req) {
  if (!dashboardPassword) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies.kcd_auth === dashboardToken;
}
function setAuthCookie(res) {
  res.setHeader('Set-Cookie', `kcd_auth=${dashboardToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `kcd_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function github(pathname, options = {}) {
  const result = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', Authorization: `Bearer ${env.GITHUB_CODESPACES_TOKEN}`, ...(options.headers || {}) },
  });
  if (!result.ok) {
    let detail = `GitHub API ${result.status}`;
    try { const body = await result.json(); detail = `${detail}: ${body.message || JSON.stringify(body)}`; } catch { /* ignore */ }
    const error = new Error(detail);
    error.status = result.status;
    throw error;
  }
  return result.status === 204 ? null : result.json();
}

function normalizeGithub(item) {
  return { id: item.name, name: item.display_name || item.name, provider: 'GitHub Codespaces', providerId: 'github', state: item.state, branch: item.git_status?.ref || 'main', repository: item.repository?.full_name || '-', url: item.web_url, updatedAt: item.updated_at };
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// Codespaces のポート転送に gh CLI で public を再適用する（ローカル実行時のみ）。
// コンテナ再起動後などに転送の visibility が private へ戻ると、公開URLが
// 404/5xx または GitHub サインイン（pf-signin）を返すため、再適用して回復を試みる。
function ensurePublicForwardVisibility(environmentId) {
  return new Promise((resolve) => {
    try {
      execFile('gh', ['codespace', 'ports', 'visibility', `${OPENCODE_PORT}:public`, '-c', environmentId], {
        env: { ...process.env, GH_TOKEN: env.GITHUB_CODESPACES_TOKEN || '' },
        windowsHide: true,
        timeout: 15000,
      }, (error) => resolve(!error));
    } catch { resolve(false); }
  });
}

async function codespaceStatusEntry(environmentId) {
  try {
    const codespace = await github(`/user/codespaces/${encodeURIComponent(environmentId)}`);
    const { kind } = describeCodespaceState(codespace.state);
    const base = { environmentId, name: codespace.display_name || codespace.name || environmentId, codespaceState: codespace.state };
    const publicUrl = codespaceForwardUrl(environmentId);
    if (kind === 'running') {
      // CodespaceはRunningでも opencode の起動が追いついていないことがあるため、公開URLへヘルスチェックする
      let health = await probeOpenCodeHealth(publicUrl, { env });
      // トンネル層の応答（404/5xx/pf-signinリダイレクト）なら、ポート転送の公開設定を再適用して再確認する
      if (!health.healthy && (health.tunnelRedirect || [404, 403, 502].includes(health.httpCode))) {
        const repaired = await ensurePublicForwardVisibility(environmentId);
        if (repaired) health = await probeOpenCodeHealth(publicUrl, { env });
      }
      const opencode = health.healthy ? 'running' : health.httpCode === 0 ? 'starting' : 'error';
      return {
        ...base,
        state: 'running',
        publicUrl,
        auth: opencodeCredentials(env),
        opencode,
        version: health.version || undefined,
        opencodeDetail: opencode === 'running'
          ? 'opencodeが応答しています'
          : opencode === 'starting'
            ? 'opencodeは起動済みです。公開URLからBasic認証で接続できます。'
            : opencodeErrorDetail(health.httpCode, { environmentId }),
      };
    }
    if (kind === 'starting') return { ...base, state: 'starting', detail: 'Codespaceを起動しています…（通常1〜2分）', publicUrl };
    if (kind === 'stopped') return { ...base, state: 'stopped' };
    return { ...base, state: 'failed', error: `Codespaceが不正な状態です（state: ${codespace.state}）` };
  } catch {
    return { environmentId, state: 'failed', error: 'Codespaceの状態を取得できませんでした。トークンの権限と有効期限を確認してください。', codespaceState: null };
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/auth/check') {
    if (!dashboardPassword) return json(response, 200, { required: false, authenticated: true });
    return json(response, 200, { required: true, authenticated: isAuthenticated(request) });
  }
  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (!dashboardPassword) return json(response, 200, { ok: true });
    const body = await readBody(request);
    if (String(body.password || '') === dashboardPassword) { setAuthCookie(response); return json(response, 200, { ok: true }); }
    return json(response, 401, { message: 'パスワードが正しくありません' });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') { clearAuthCookie(response); return json(response, 200, { ok: true }); }
  const publicPaths = ['/login', '/login.html', '/api/login', '/api/auth/check', '/api/logout'];
  const isPublic = publicPaths.includes(url.pathname) || url.pathname === '/style.css';
  if (!isPublic && dashboardPassword && !isAuthenticated(request)) {
    if (url.pathname.startsWith('/api/')) return json(response, 401, { message: '認証が必要です', code: 'unauthorized' });
    response.writeHead(302, { Location: '/login.html' });
    return response.end();
  }
  if (url.pathname === '/login') { response.writeHead(302, { Location: '/login.html' }); return response.end(); }
  if (url.pathname === '/api/status') return json(response, 200, { providers, vercel: isVercel });
  if (url.pathname === '/api/config') return json(response, 200, { configured: providers, vercel: isVercel });
  if (url.pathname === '/api/environments' && request.method === 'GET') {
    const environments = [];
    const errors = [];
    if (providers.codespaces) {
      try { const data = await github('/user/codespaces?per_page=100'); environments.push(...(data.codespaces || []).map(normalizeGithub)); } catch { errors.push('GitHub Codespaces'); }
    }
    return json(response, 200, { environments, errors });
  }
  if (url.pathname === '/api/repos' && request.method === 'GET') {
    if (!providers.codespaces) return json(response, 400, { message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
    try {
      const data = await github('/user/repos?per_page=100&visibility=all&sort=updated');
      return json(response, 200, { repos: (data || []).map((item) => ({ id: item.id, fullName: item.full_name, private: item.private })) });
    } catch (error) { return json(response, 502, { message: error.message || 'リポジトリ一覧の取得に失敗しました。' }); }
  }
  if (url.pathname === '/api/environments' && request.method === 'POST') {
    const body = await readBody(request);
    if (!providers.codespaces) return json(response, 400, { message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
    if (!body.repositoryId && !body.repo) return json(response, 400, { message: 'リポジトリが必要です。自分のリポジトリを選ぶか、GitHubで先にリポジトリを作成してください。' });
    try {
      let repositoryId = body.repositoryId;
      let repoName = body.repo;
      let defaultBranch = null;
      if (body.repo) {
        const [owner, repo] = String(body.repo).split('/');
        if (owner && repo) {
          const repoInfo = await github(`/repos/${owner}/${repo}`);
          repositoryId = repoInfo.id; repoName = repoInfo.full_name || body.repo; defaultBranch = repoInfo.default_branch || null;
        }
        else return json(response, 400, { message: 'リポジトリは owner/repo 形式で入力してください。' });
      }
      const numericRepositoryId = Number(repositoryId);
      if (!Number.isInteger(numericRepositoryId) || numericRepositoryId <= 0) return json(response, 400, { message: 'リポジトリIDが不正です。リポジトリを選択し直してください。' });
      const createBody = {};
      createBody.repository_id = numericRepositoryId;
      const branch = body.ref || defaultBranch;
      if (branch) createBody.ref = branch;
      if (body.name) createBody.display_name = body.name;
      if (body.machine) createBody.machine = body.machine;
      const payload = await github('/user/codespaces', { method: 'POST', body: JSON.stringify(createBody), headers: { 'Content-Type': 'application/json' } });
      return json(response, 201, { id: payload.name, name: payload.display_name || payload.name, repository: repoName || null, web_url: payload.web_url, state: payload.state });
    } catch (error) {
      const reason = error.message || '';
      let hint = '';
      if (error.status === 403) hint = 'トークンがこのリポジトリにアクセスできないか、リポジトリ作成権限がありません。自分のリポジトリを選択し、トークンのリポジトリアクセスの範囲を確認してください。';
      return json(response, 502, { message: `Codespacesの作成に失敗しました。${hint}${reason}` });
    }
  }
  const actionMatch = url.pathname.match(/^\/api\/environments\/github\/([^/]+)\/(start|stop)$/);
  if (actionMatch && request.method === 'POST') {
    const [, rawId, action] = actionMatch;
    if (!providers.codespaces) return json(response, 400, { message: 'この操作は現在GitHub Codespacesで利用できます。' });
    try {
      const data = await github(`/user/codespaces/${encodeURIComponent(rawId)}/${action}`, { method: 'POST' });
      return json(response, 200, data || { ok: true });
    } catch (error) {
      const reason = error.message || '';
      if (action === 'stop') {
        // 起動中は停止APIが拒否される場合がある。現在の状態を確認して案内する
        try {
          const codespace = await github(`/user/codespaces/${encodeURIComponent(rawId)}`);
          const { kind } = describeCodespaceState(codespace.state);
          if (kind === 'stopped') return json(response, 200, { ok: true, state: codespace.state });
          if (kind === 'starting') return json(response, 409, { message: 'Codespaceが起動中です。起動完了（Running）後に停止してください。', state: codespace.state });
        } catch { /* 状態取得できなければ通常のエラーとして返す */ }
      }
      return json(response, 502, { message: `Codespaces APIで操作できませんでした。${reason}` });
    }
  }
  const deleteMatch = url.pathname.match(/^\/api\/environments\/github\/([^/]+)$/);
  if (deleteMatch && request.method === 'DELETE') {
    const [, rawId] = deleteMatch;
    if (!providers.codespaces) return json(response, 400, { message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
    try {
      await github(`/user/codespaces/${encodeURIComponent(rawId)}`, { method: 'DELETE' });
      return json(response, 200, { ok: true });
    } catch { return json(response, 502, { message: 'Codespacesの削除に失敗しました。' }); }
  }
  if (url.pathname === '/api/opencode/serve' && request.method === 'POST') {
    if (!providers.codespaces) return json(response, 400, { message: 'GitHub CodespacesのPersonal access tokenを設定してください。' });
    const body = await readBody(request);
    const environmentId = String(body.environmentId || '');
    if (!environmentId) return json(response, 400, { message: '起動対象の環境が指定されていません。' });
    try {
      // CodespaceをREST APIで起動（非同期。opencode自体はCodespace内のdevcontainerで常駐起動済み）
      const codespace = await startCodespaceIfNeeded(environmentId);
      const { kind } = describeCodespaceState(codespace.state);
      const publicUrl = codespaceForwardUrl(environmentId);
      if (kind === 'running') return json(response, 200, { status: 'running', environmentId, publicUrl, auth: opencodeCredentials(env), codespaceState: codespace.state });
      if (kind === 'failed') return json(response, 409, { status: 'failed', environmentId, codespaceState: codespace.state, message: 'Codespaceが利用できない状態です。環境の削除や再作成を検討してください。' });
      return json(response, 202, { status: 'starting', environmentId, publicUrl, auth: opencodeCredentials(env), codespaceState: codespace.state, detail: 'Codespaceを起動しています…（通常1〜2分）' });
    } catch (error) {
      console.error('opencode serve error:', error.message || error);
      return json(response, 502, { message: `OpenCodeを起動できませんでした。${error.message || ''}` });
    }
  }
  if (url.pathname === '/api/presence') {
    const presenceToken = env.GITLAB_TOKEN || env.GITLAB_PRESENCE_TOKEN || '';
    const presenceRepo = env.GITLAB_PRESENCE_REPO || 'Densyakun/config-opencode';
    const presenceUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(presenceRepo)}/repository/files/presence.json/raw?ref=main`;
    async function localReadPresence() {
      if (!presenceToken) return { monitoring: true, configured: false };
      try {
        const r = await fetch(presenceUrl, { headers: { 'PRIVATE-TOKEN': presenceToken } });
        if (r.status === 404) return { monitoring: true, configured: true };
        if (!r.ok) throw new Error(`GitLab API ${r.status}`);
        const text = await r.text();
        try { return { ...JSON.parse(text), configured: true }; } catch { return { monitoring: true, configured: true }; }
      } catch (error) { return { monitoring: true, configured: true, error: error.message }; }
    }
    async function localWritePresence(monitoring) {
      if (!presenceToken) throw new Error('GITLAB_TOKEN が設定されていません。');
      const filePath = `https://gitlab.com/api/v4/projects/${encodeURIComponent(presenceRepo)}/repository/files/presence.json`;
      const content = Buffer.from(JSON.stringify({ monitoring, updatedAt: new Date().toISOString() }, null, 2)).toString('base64');
      const putRes = await fetch(filePath, { method: 'PUT', headers: { 'PRIVATE-TOKEN': presenceToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: 'main', content, commit_message: `chore: presence ${monitoring ? 'on' : 'off'}`, encoding: 'base64' }) });
      if (!putRes.ok) {
        const postRes = await fetch(filePath, { method: 'POST', headers: { 'PRIVATE-TOKEN': presenceToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: 'main', content, commit_message: `chore: presence ${monitoring ? 'on' : 'off'}`, encoding: 'base64' }) });
        if (!postRes.ok) throw new Error(`GitLab API ${postRes.status}`);
      }
    }
    if (request.method === 'GET') {
      try { return json(response, 200, await localReadPresence()); } catch (error) { return json(response, 502, { message: error.message }); }
    }
    if (request.method === 'POST') {
      const body = await readBody(request);
      try { await localWritePresence(body.monitoring !== false); return json(response, 200, { ok: true, monitoring: body.monitoring !== false }); }
      catch (error) { return json(response, 502, { message: error.message }); }
    }
    return json(response, 405, { message: 'Method Not Allowed' });
  }
  if (url.pathname === '/api/opencode/status' && request.method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const states = await Promise.all(ids.map(codespaceStatusEntry));
    return json(response, 200, { states, vercel: isVercel });
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(root, 'public', path.normalize(file));
  if (!filePath.startsWith(path.join(root, 'public'))) return json(response, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  if (!existsSync(filePath)) return json(response, 404, { error: 'Not found' });
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
});

server.listen(serverPort, () => console.log(`Kozmik Cloud Dashboard running at http://localhost:${serverPort}`));