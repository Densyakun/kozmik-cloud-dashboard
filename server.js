import http from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import os from 'node:os';
import net from 'node:net';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tunnels = new Map();
const serveStates = new Map();

const OPENCODE_RELEASE_URL = 'https://github.com/sst/opencode/releases/latest/download/opencode-linux-x64.tar.gz';

async function ensureLocalOpenCodeTgz() {
  const cacheDir = path.join(root, '.opencode-cache');
  const tgz = path.join(cacheDir, 'opencode.tgz');
  if (existsSync(tgz) && statSync(tgz).size > 50 * 1024 * 1024) return tgz;
  await mkdir(cacheDir, { recursive: true });
  const res = await fetch(OPENCODE_RELEASE_URL);
  if (!res.ok) throw new Error(`opencodeのダウンロードに失敗しました(HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(tgz, buf);
  if (!existsSync(tgz) || statSync(tgz).size < 50 * 1024 * 1024) throw new Error('opencodeのダウンロードに失敗しました');
  return tgz;
}

function pipeFileToRemote(ghPath, environmentId, localFile, remotePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ghPath, ['codespace', 'ssh', '--codespace', environmentId, '--', 'cat', '>', remotePath, '&&', 'echo', 'TRANSFER_DONE'], {
      env: { ...process.env, GH_TOKEN: env.GITHUB_CODESPACES_TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => out += d.toString());
    child.stderr.on('data', (d) => out += d.toString());
    const reader = createReadStream(localFile);
    reader.pipe(child.stdin);
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error('バイナリ転送がタイムアウトしました')); }, 600000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && /TRANSFER_DONE/.test(out)) { reader.close(); resolve(); }
      else reject(new Error(`バイナリ転送に失敗しました(exit ${code})`));
    });
  });
}

async function runOpenCodeServe(environmentId) {
  const existingState = serveStates.get(environmentId);
  const state = existingState || { status: 'starting', publicUrl: null, password: null, error: null, port: null, username: null, detail: null };
  state.status = 'starting';
  state.detail = '準備中…';
  state.error = null;
  state.username = env.OPENCODE_SERVER_USERNAME || 'opencode';
  serveStates.set(environmentId, state);
  const password = env.OPENCODE_SERVER_PASSWORD || crypto.randomBytes(12).toString('base64url');
  if (isVercel) {
    state.status = 'failed';
    state.detail = null;
    state.error = 'OpenCodeのSSHトンネル起動はVercelでは利用できません（サーバーレス関数ではSSHトンネルを保持できないため）。ローカルの node server.js でご利用ください。';
    return;
  }
  const ghPath = await resolveGh();
  if (!ghPath) {
    state.status = 'failed';
    state.error = 'gh CLIが見つかりません。winget install --id GitHub.cli でインストールしてサーバーを再起動してください。';
    return;
  }
  const ssh = (args, opts = {}) => exec(ghPath, ['codespace', 'ssh', '--codespace', environmentId, '--', ...args], { env: { ...process.env, GH_TOKEN: env.GITHUB_CODESPACES_TOKEN }, timeout: 240000, ...opts });
  const sshRetry = async (args, opts = {}) => {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await ssh(args, opts); } catch (e) { last = e; await sleep(4000 * (attempt + 1)); }
    }
    throw last;
  };
  try {
    state.detail = 'Codespaceを起動中…（通常1〜2分）';
    const tgzPromise = ensureLocalOpenCodeTgz().catch((e) => { throw e; });
    await ensureCodespaceRunning(environmentId);
    await sleep(2000);
    console.error('[serve] codespace ready');

    // 高速パス: 既存トンネルが生きていればそのまま再利用（serve再起動・転送なし）
    state.detail = '既存の接続を確認中…';
    const cachedTunnel = tunnels.get(environmentId);
    if (cachedTunnel && cachedTunnel.child && cachedTunnel.child.exitCode === null && await probePort(cachedTunnel.port)) {
      state.status = 'running';
      state.detail = null;
      state.port = cachedTunnel.port;
      state.publicUrl = `http://${lanIp()}:${await ensureOcProxy(environmentId, cachedTunnel.port)}/`;
      state.error = null;
      return;
    }

    state.detail = '作業ディレクトリを準備中…';
    await sshRetry(['mkdir', '-p', '~/.opencode-cli']);

    // バイナリは既に転送済みなら転送をスキップ（初回のみ60MB転送）
    state.detail = 'opencodeバイナリを確認中…';
    let hasBin = false;
    try { const r = await sshRetry(['test', '-f', '~/.opencode-cli/opencode', '&&', 'echo', 'HAS_BIN']); hasBin = /HAS_BIN/.test(r.stdout || ''); } catch { /* ignore */ }
    if (!hasBin) {
      state.detail = 'opencodeを準備中…';
      let localTgz;
      try { localTgz = await tgzPromise; }
      catch (e) { state.status = 'failed'; state.detail = null; state.error = `opencodeの取得に失敗しました。${e.message || ''}`; return; }
      const hadTransfer = await sshRetry(['test', '-f', '~/.opencode-cli/opencode.tgz', '&&', 'echo', 'HAS_TGZ']).then((r) => /HAS_TGZ/.test(r.stdout || '')).catch(() => false);
      if (!hadTransfer) {
        state.detail = 'opencodeを転送中…（初回のみ60MB・1〜2分）';
        try { await pipeFileToRemote(ghPath, environmentId, localTgz, '~/.opencode-cli/opencode.tgz'); }
        catch (e) { state.status = 'failed'; state.detail = null; state.error = `Codespaceへのopencode転送に失敗しました（${e.message || ''}）。`; return; }
      }
      state.detail = '転送したopencodeを展開中…';
      await sshRetry(['tar', '-xzf', '~/.opencode-cli/opencode.tgz', '-C', '~/.opencode-cli']);
      await sshRetry(['chmod', '+x', '~/.opencode-cli/opencode']);
    }

    // serveは既に起動済み(port4096)なら再起動しない
    state.detail = '起動状態を確認中…';
    let serving = false;
    try { const r = await sshRetry(['ss', '-ltn', '|', 'grep', '-q', ':4096', '&&', 'echo', 'SERVING']); serving = /SERVING/.test(r.stdout || ''); } catch { /* ignore */ }
    if (!serving) {
      state.detail = 'opencode serveを起動中…';
      const serveArgs = ['cd', '~/.opencode-cli', '&&', `OPENCODE_SERVER_PASSWORD=${password}`, `OPENCODE_API_KEY=${env.OPENCODE_API_KEY || ''}`, 'setsid', './opencode', 'serve', '--hostname', '0.0.0.0', '--port', '4096', '>', '/tmp/oc-serve.log', '2>&1', '</dev/null', '&'];
      console.error('[serve] launching serve');
      try { await sshRetry(serveArgs, { timeout: 60000 }); }
      catch { /* backgrounding may return nonzero; proceed to tunnel */ }
      await sleep(4000);
    }

    state.detail = 'トンネルを確立中…';
    const port = await ensureTunnel(environmentId, ghPath);
    console.error('[serve] tunnel done port=', port);
    if (!port) {
      let log = '';
      try { const r = await ssh(['cat', '/tmp/oc-serve.log']); log = (r.stdout || '').slice(0, 800); } catch { /* ignore */ }
      state.status = 'failed';
      state.detail = null;
      state.error = `SSHトンネルの確立に失敗しました。${log ? 'ログ: ' + log : '（serveログなし）'}`;
      return;
    }
    state.detail = '公開URLを作成中…';
    const proxyPort = await createOcProxy(environmentId, port);
    state.status = 'running';
    state.detail = null;
    state.publicUrl = `http://${lanIp()}:${proxyPort}/`;
    state.password = password;
    state.username = env.OPENCODE_SERVER_USERNAME || 'opencode';
    state.port = port;
    state.error = null;
  } catch (error) {
    console.error('opencode serve error:', error.message || error);
    state.status = 'failed';
    state.detail = null;
    state.error = error.message || String(error);
  }
}

function lanIp() {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) {
        const a = item.address.split('.').map(Number);
        const isPrivate = a[0] === 10 || (a[0] === 192 && a[1] === 168) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31);
        if (isPrivate) return item.address;
      }
    }
  }
  return '127.0.0.1';
}

function getFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    server.on('error', () => resolve(0));
  });
}

async function probePort(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    return true;
  } catch { return false; }
}

async function findGhFiles(dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findGhFiles(full));
    } else if (entry.name.toLowerCase() === 'gh.exe') {
      found.push(full);
    }
  }
  return found;
}

async function resolveGh() {
  const candidates = [];
  if (process.env.GH_PATH) candidates.push(process.env.GH_PATH);
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe'));
    try {
      const ghExes = await findGhFiles(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'));
      candidates.push(...ghExes);
    } catch { /* ignore */ }
  }
  for (const candidate of candidates) { if (candidate && existsSync(candidate)) return candidate; }
  try { const result = await exec('where', ['gh.exe']); if (result.stdout) return result.stdout.trim().split(/\r?\n/)[0]; } catch { /* not on PATH */ }
  return null;
}

async function ensureCodespaceRunning(name) {
  const isReady = (s) => /avail|run|active/i.test(s);
  const isStopped = (s) => /shutdown|stopped|archived/i.test(s);
  for (let attempt = 0; attempt < 3; attempt++) {
    let status = await github(`/user/codespaces/${encodeURIComponent(name)}`);
    let st = (status.state || '').toLowerCase();
    if (isReady(st)) return status;
    if (/fail|deleted/i.test(st)) throw new Error(`Codespaceが不正な状態です(state: ${status.state})`);
    if (isStopped(st)) await github(`/user/codespaces/${encodeURIComponent(name)}/start`, { method: 'POST' });
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      status = await github(`/user/codespaces/${encodeURIComponent(name)}`);
      st = (status.state || '').toLowerCase();
      if (isReady(st)) return status;
      if (/fail|deleted/i.test(st)) throw new Error(`Codespaceの起動に失敗しました(state: ${status.state})`);
      if (isStopped(st)) break;
    }
  }
  throw new Error('Codespaceがタイムアウトで起動しませんでした');
}

async function ensureTunnel(environmentName, ghPath) {
  const existing = tunnels.get(environmentName);
  if (existing && existing.child && existing.child.exitCode === null && await probePort(existing.port)) return existing.port;
  if (existing && existing.child) { try { existing.child.kill(); } catch { /* ignore */ } }
  const port = await getFreePort();
  if (!port) return null;
  const child = spawn(ghPath, ['codespace', 'ssh', '--codespace', environmentName, '--', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=12', '-N', '-L', `${port}:localhost:4096`], {
    env: { ...process.env, GH_TOKEN: env.GITHUB_CODESPACES_TOKEN },
    stdio: 'ignore',
    detached: false,
  });
  tunnels.set(environmentName, { child, port });
  child.on('exit', () => { if (tunnels.get(environmentName)?.child === child) tunnels.delete(environmentName); });
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    if (await probePort(port)) return port;
    if (child.exitCode !== null) break;
  }
  try { child.kill(); } catch { /* ignore */ }
  tunnels.delete(environmentName);
  return null;
}

process.on('exit', () => {
  for (const { child } of tunnels.values()) { try { child.kill(); } catch { /* ignore */ } }
  for (const { server } of ocProxies.values()) { try { server.close(); } catch { /* ignore */ } }
});

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

// Vercelのサーバーレスランタイムでは process.env.VERCEL が設定される。
// ステートレスな関数ではSSHトンネル・固定公開ポートを保持できないため、
// opencode serveの起動は無効化し、案内メッセージを返す。
const isVercel = Boolean(process.env.VERCEL);

const serverPort = Number(env.PORT || 3000);
const providers = {
  codespaces: Boolean(env.GITHUB_CODESPACES_TOKEN),
  ona: Boolean(env.ONA_PERSONAL_ACCESS_TOKEN),
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

async function onaApi(method, body = {}) {
  const base = String(env.ONA_API_HOST || 'https://app.ona.com');
  let url = `${base}/api/gitpod.v1.${method}`;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ONA_PERSONAL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`Ona API redirect without location (${res.status})`);
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) {
      let detail = `Ona API ${res.status}`;
      try { const body = await res.json(); detail = `${detail}: ${body.message || JSON.stringify(body)}`; } catch { /* ignore */ }
      const error = new Error(detail);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }
  throw new Error('Ona API redirect loop');
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

const ocProxies = new Map(); // envId -> { server, port }

function closeOcProxy(environmentId) {
  const entry = ocProxies.get(environmentId);
  if (entry && entry.server) { try { entry.server.close(); } catch { /* ignore */ } }
  ocProxies.delete(environmentId);
}

function ocProxyPortFor(environmentId) {
  let h = 0;
  for (let i = 0; i < environmentId.length; i++) h = (h * 31 + environmentId.charCodeAt(i)) >>> 0;
  return 41000 + (h % 10000);
}

function createOcProxy(environmentId, tunnelPort) {
  const basePort = ocProxyPortFor(environmentId);
  const tryListen = (port) => new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => {
      const hdrs = { ...req.headers, host: `127.0.0.1:${tunnelPort}` };
      delete hdrs['accept-encoding'];
      const upstream = http.request({ host: '127.0.0.1', port: tunnelPort, path: req.url, method: req.method, headers: hdrs });
      upstream.on('response', (upstreamResponse) => { res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers); upstreamResponse.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'proxy error' }); else res.end(); });
      req.pipe(upstream);
    });
    httpServer.on('upgrade', (req, socket, head) => {
      const up = net.connect(tunnelPort, '127.0.0.1', () => {
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        up.write(raw + '\r\n');
        if (head && head.length) up.write(head);
      });
      socket.on('error', () => up.destroy());
      up.on('error', () => socket.destroy());
      req.on('error', () => {});
      up.pipe(socket);
      socket.pipe(up);
    });
    httpServer.on('error', (err) => reject(err));
    httpServer.listen(port, '0.0.0.0', () => {
      ocProxies.set(environmentId, { server: httpServer, port, targetPort: tunnelPort });
      resolve(port);
    });
  });
  return (async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = basePort + attempt > 59999 ? basePort + attempt - 10000 : basePort + attempt;
      try { return await tryListen(candidate); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
    }
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        const hdrs = { ...req.headers, host: `127.0.0.1:${tunnelPort}` };
        delete hdrs['accept-encoding'];
        const up = http.request({ host: '127.0.0.1', port: tunnelPort, path: req.url, method: req.method, headers: hdrs });
        up.on('response', (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
        up.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'proxy error' }); else res.end(); });
        req.pipe(up);
      });
      s.on('upgrade', (req, socket, head) => {
        const up = net.connect(tunnelPort, '127.0.0.1', () => {
          let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
          up.write(raw + '\r\n');
          if (head && head.length) up.write(head);
        });
        socket.on('error', () => up.destroy());
        up.on('error', () => socket.destroy());
        up.pipe(socket); socket.pipe(up);
      });
      s.listen(0, '0.0.0.0', () => { const p = s.address().port; ocProxies.set(environmentId, { server: s, port: p, targetPort: tunnelPort }); resolve(p); });
      s.on('error', reject);
    });
  })();
}

function ensureOcProxy(environmentId, tunnelPort) {
  const existing = ocProxies.get(environmentId);
  if (existing && existing.server && existing.port && existing.targetPort === tunnelPort) {
    try { if (existing.server.listening) return Promise.resolve(existing.port); } catch { /* ignore */ }
  }
  closeOcProxy(environmentId);
  return createOcProxy(environmentId, tunnelPort);
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
    if (providers.ona) {
      try {
        const data = await onaApi('EnvironmentService/ListEnvironments', {});
        environments.push(...(data.environments || []).map((item) => ({ id: item.id, name: item.displayName || item.metadata?.name || item.id, provider: 'Ona Cloud', providerId: 'ona', state: item.status?.phase || item.phase || 'ENVIRONMENT_PHASE_UNSPECIFIED', branch: item.spec?.content?.initializer?.specs?.[0]?.git?.cloneTarget || 'main', repository: item.metadata?.originalContextUrl || '-', url: item.status?.environmentUrls?.web || item.url, updatedAt: item.metadata?.lastStartedAt || item.updatedAt })));
      } catch (error) { console.error('ona error:', error.message); errors.push('Ona Cloud'); }
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
  if (url.pathname === '/api/ona/classes' && request.method === 'GET') {
    if (!providers.ona) return json(response, 400, { message: 'ONA_PERSONAL_ACCESS_TOKEN が設定されていません。' });
    try {
      const data = await onaApi('EnvironmentService/ListEnvironmentClasses', {});
      const classes = (data.environmentClasses || []).filter((c) => c.enabled !== false).map((c) => ({ id: c.id, name: c.displayName || c.id, description: c.description || c.id, runnerId: c.runnerId }));
      return json(response, 200, { classes });
    } catch (error) { return json(response, 502, { message: `Ona Cloudのマシンクラス取得に失敗しました。${error.message || ''}` }); }
  }
  if (url.pathname === '/api/environments' && request.method === 'POST') {
    const body = await readBody(request);
    if (body.provider === 'ona') {
      if (!providers.ona) return json(response, 400, { message: 'ONA_PERSONAL_ACCESS_TOKEN が設定されていません。' });
      const repoUrl = String(body.repoUrl || '').trim();
      const machineClass = String(body.machineClass || '').trim();
      if (!repoUrl) return json(response, 400, { message: 'リポジトリのURLを入力してください。' });
      if (!machineClass) return json(response, 400, { message: 'マシンクラスを選択してください。' });
      try {
        const spec = { spec: { specVersion: '1', machine: { class: machineClass }, content: { initializer: { specs: [{ contextUrl: { url: repoUrl } }] } } } };
        if (body.name) spec.name = String(body.name);
        const payload = await onaApi('EnvironmentService/CreateEnvironment', spec);
        const item = payload.environment || {};
        const state = item.status?.phase || 'ENVIRONMENT_PHASE_UNSPECIFIED';
        return json(response, 201, { id: item.id, name: body.name || item.id, repository: repoUrl, state, url: item.status?.environmentUrls?.web || null });
      } catch (error) {
        const reason = error.message || '';
        const billing = /subscription/i.test(reason);
        const guide = billing
          ? 'このアカウントの組織はアクティブな契約（subscription）がありません。Onaコンソールの「Settings > Billing」で契約を開始してください。'
          : '';
        return json(response, billing ? 403 : 502, { code: billing ? 'needs_subscription' : 'create_failed', message: `Ona Cloudの環境作成に失敗しました。${guide}${reason}` });
      }
    }
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
  const actionMatch = url.pathname.match(/^\/api\/environments\/(github|ona)\/([^/]+)\/(start|stop)$/);
  if (actionMatch && request.method === 'POST') {
    const [, provider, rawId, action] = actionMatch;
    if (provider !== 'github' || !providers.codespaces) return json(response, 400, { message: 'この操作は現在GitHub Codespacesで利用できます。' });
    try { const data = await github(`/user/codespaces/${encodeURIComponent(rawId)}/${action}`, { method: 'POST' }); return json(response, 200, data || { ok: true }); } catch { return json(response, 502, { message: 'Codespaces APIで操作できませんでした。' }); }
  }
  const deleteMatch = url.pathname.match(/^\/api\/environments\/(github|ona)\/([^/]+)$/);
  if (deleteMatch && request.method === 'DELETE') {
    const [, provider, rawId] = deleteMatch;
    if (provider === 'github') {
      if (!providers.codespaces) return json(response, 400, { message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
      try {
        await github(`/user/codespaces/${encodeURIComponent(rawId)}`, { method: 'DELETE' });
        const tunnel = tunnels.get(rawId);
        if (tunnel && tunnel.child) { try { tunnel.child.kill(); } catch { /* ignore */ } }
        tunnels.delete(rawId);
        closeOcProxy(rawId);
        serveStates.delete(rawId);
        return json(response, 200, { ok: true });
      } catch { return json(response, 502, { message: 'Codespacesの削除に失敗しました。' }); }
    }
    if (provider === 'ona') {
      if (!providers.ona) return json(response, 400, { message: 'ONA_PERSONAL_ACCESS_TOKEN が設定されていません。' });
      try {
        await onaApi('EnvironmentService/DeleteEnvironment', { environmentId: rawId });
        closeOcProxy(rawId);
        serveStates.delete(rawId);
        return json(response, 200, { ok: true });
      } catch (error) {
        console.error('ona delete error:', error.message);
        return json(response, 502, { message: `Ona Cloudの環境削除に失敗しました。${error.message || ''}` });
      }
    }
  }
  if (url.pathname === '/api/opencode/serve' && request.method === 'POST') {
    const body = await readBody(request);
    if (!providers.codespaces) return json(response, 400, { message: 'GitHub CodespacesのPersonal access tokenを設定してください。' });
    if (!body.environmentId) return json(response, 400, { message: '起動対象の環境が指定されていません。' });
    if (isVercel) {
      return json(response, 501, {
        code: 'not_available_on_vercel',
        message: 'OpenCodeのSSHトンネル起動はVercelでは利用できません。Vercelの関数はステートレスなため、SSHトンネルや固定公開ポートを保持できません。完全な機能はローカルの node server.js で利用するか、対象リポジトリの .devcontainer に forwardPorts と opencode 起動を設定し、Codespaces の公開URL（https://<codespace>-4096.app.github.dev）をご利用ください。',
      });
    }
    if (serveStates.get(body.environmentId)?.status === 'starting' || serveStates.get(body.environmentId)?.status === 'running') {
      return json(response, 200, { status: serveStates.get(body.environmentId).status });
    }
    runOpenCodeServe(body.environmentId);
    return json(response, 202, { status: 'starting' });
  }
  if (url.pathname === '/api/opencode/status' && request.method === 'GET') {
    if (isVercel) return json(response, 200, { states: [], vercel: true, message: 'OpenCodeトンネルはVercelでは提供されません。' });
    if (providers.codespaces) {
      for (const [environmentId, state] of serveStates) {
        if (state.status !== 'running' || !state.port) continue;
        if (!await probePort(state.port)) {
          const code = await github(`/user/codespaces/${encodeURIComponent(environmentId)}`).catch(() => null);
          const csState = (code?.state || '').toLowerCase();
          const ready = /avail|run|active|start|provision/i.test(csState);
          if (!ready) {
            const tunnel = tunnels.get(environmentId);
            if (tunnel && tunnel.child) { try { tunnel.child.kill(); } catch { /* ignore */ } }
            tunnels.delete(environmentId);
            closeOcProxy(environmentId);
            state.status = 'stopped';
            state.publicUrl = null;
            state.error = `Codespaceが停止しました（state: ${code?.state || '不明'}）。再起動してください。`;
          } else {
            // Codespaceは稼働中なのにトンネルが切れた → トンネルを張り直して復旧を試みる
            const ghPath = await resolveGh();
            const newPort = ghPath ? await ensureTunnel(environmentId, ghPath) : null;
            if (newPort) {
              state.port = newPort;
              state.status = 'running';
              closeOcProxy(environmentId);
              const proxyPort = await createOcProxy(environmentId, newPort);
              state.publicUrl = `http://${lanIp()}:${proxyPort}/`;
              state.error = null;
            } else {
              closeOcProxy(environmentId);
              state.status = 'stopped';
              state.publicUrl = null;
              state.error = 'OpenCodeの接続が切れました（トンネル停止）。再起動してください。';
            }
          }
        }
      }
    }
    const list = [];
    for (const [environmentId, state] of serveStates) {
      const code = await github(`/user/codespaces/${encodeURIComponent(environmentId)}`).catch(() => null);
      list.push({ environmentId, name: code?.display_name || code?.name || environmentId, state: state.status, publicUrl: state.publicUrl || null, password: state.password || null, username: state.username || env.OPENCODE_SERVER_USERNAME || 'opencode', detail: state.detail || null, error: state.error || null, codespaceState: code?.state || null });
    }
    return json(response, 200, { states: list });
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
