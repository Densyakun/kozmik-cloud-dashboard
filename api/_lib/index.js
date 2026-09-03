import crypto from 'node:crypto';

// opencode は Codespace 側（.devcontainer の postStartCommand）でポート4096に常駐させる。
// ダッシュボードは GitHub REST API で起動/状態確認だけを行い、公開URLを表示する。
const OPENCODE_PORT = 4096;

export function codespaceForwardUrl(name) {
  return `https://${name}-${OPENCODE_PORT}.app.github.dev`;
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
    ona: Boolean(process.env.ONA_PERSONAL_ACCESS_TOKEN),
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

export async function onaApi(method, body = {}) {
  const token = process.env.ONA_PERSONAL_ACCESS_TOKEN;
  if (!token) throw Object.assign(new Error('ONA_PERSONAL_ACCESS_TOKEN が設定されていません'), { status: 400 });
  const base = String(process.env.ONA_API_HOST || 'https://app.ona.com');
  let url = `${base}/api/gitpod.v1.${method}`;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Ona API redirect without location (${res.status})`);
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) {
      let detail = `Ona API ${res.status}`;
      try { const b = await res.json(); detail = `${detail}: ${b.message || JSON.stringify(b)}`; } catch {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  throw new Error('Ona API redirect loop');
}

export function normalizeGithub(item) {
  return { id: item.name, name: item.display_name || item.name, provider: 'GitHub Codespaces', providerId: 'github', state: item.state, branch: item.git_status?.ref || 'main', repository: item.repository?.full_name || '-', url: item.web_url, updatedAt: item.updated_at };
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
