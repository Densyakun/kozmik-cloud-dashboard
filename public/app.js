const toast = document.querySelector('#toast');
function notify(message) { toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2600); }
let isVercel = false;
fetch('/api/auth/check').then(r=>r.json()).then(d=>{ if(d.required && !d.authenticated) location.href='/login.html'; }).catch(()=>{});
document.querySelector('#logoutBtn')?.addEventListener('click', async ()=>{ await fetch('/api/logout',{method:'POST'}); location.href='/login.html'; });
const origFetch = window.fetch;
window.fetch = async (...args) => { const res = await origFetch(...args); if(res.status===401){ const ct=res.headers.get('content-type')||''; if(ct.includes('json')){ const d=await res.clone().json().catch(()=>({})); if(d.code==='unauthorized') location.href='/login.html'; } else location.href='/login.html'; } return res; };
const newEnvDialog = document.querySelector('#newEnvDialog');
document.querySelector('#cancelNewEnv').addEventListener('click', () => newEnvDialog.close());
document.querySelector('#openSettings').addEventListener('click', () => document.querySelector('#setupDialog').showModal());
document.querySelector('#newEnvForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#envName').value.trim();
  const button = document.querySelector('#submitNewEnv');
  button.disabled = true;
  button.textContent = '作成中...';
  const errorBox = document.querySelector('#newEnvError');
  errorBox.hidden = true;
  try {
    const body = { provider: 'github', name: name || undefined };
    const repoOption = document.querySelector('#envRepo').selectedOptions[0];
    const repo = repoOption ? repoOption.value : '';
    if (repo !== '') { body.repositoryId = repoOption.dataset.id || undefined; body.repo = repo; }
    const result = await fetch('/api/environments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await result.json();
    if (!result.ok) {
      errorBox.hidden = false;
      const actions = `<div class="dialog-actions"><button type="button" class="ghost-button" onclick="document.querySelector('#setupDialog').showModal()">設定を開く</button><a class="ghost-button" href="https://github.com/new" target="_blank" rel="noopener">リポジトリ作成 ↗</a></div>`;
      errorBox.innerHTML = `<p>${data.message || '作成に失敗しました'}</p>${actions}`;
      return;
    }
    notify(`環境を作成しました: ${data.web_url || data.name || ''}`);
    newEnvDialog.close();
    setTimeout(loadConnectedEnvironments, 1500);
  } catch { notify('サーバーに接続できません'); }
  finally { button.disabled = false; button.textContent = '作成する'; }
});
const DEFAULT_REPO = 'Densyakun/opencode-workspace';
async function loadRepos() {
  const select = document.querySelector('#envRepo');
  select.innerHTML = '<option value="">読み込み中...</option>';
  try {
    const result = await fetch('/api/repos');
    const data = await result.json();
    if (!result.ok) { select.innerHTML = `<option value="">${data.message || '取得できません'}</option>`; return; }
    if (!data.repos?.length) { select.innerHTML = '<option value="">リポジトリありません</option>'; return; }
    select.innerHTML = data.repos.map((item) => `<option value="${item.fullName}" data-id="${item.id}">${item.fullName}${item.private ? ' (private)' : ''}</option>`).join('');
    // 作成時の既定リポジトリを選択（一覧に無ければ先頭に追加。サーバー側でID解決される）
    let selected = [...select.options].find((o) => o.value.toLowerCase() === DEFAULT_REPO.toLowerCase());
    if (!selected) {
      selected = document.createElement('option');
      selected.value = DEFAULT_REPO;
      selected.textContent = `${DEFAULT_REPO}（既定）`;
      select.prepend(selected);
    }
    select.value = selected.value;
  } catch { select.innerHTML = '<option value="">取得に失敗しました</option>'; }
}
document.querySelector('#refreshRepos').addEventListener('click', loadRepos);
document.querySelector('#newProject').addEventListener('click', () => { loadRepos(); newEnvDialog.showModal(); });
function bindEnvironmentActions() {
  document.querySelectorAll('.open-button').forEach((button) => button.addEventListener('click', () => { if (button.dataset.url) window.open(button.dataset.url, '_blank', 'noopener'); else notify(`${button.dataset.env} のワークスペースを開いています`); }));
  document.querySelectorAll('.opencode-button').forEach((button) => button.addEventListener('click', async () => { await launchOpenCode(button.dataset.env); }));
  document.querySelectorAll('.delete-button').forEach((button) => button.addEventListener('click', () => openDeleteConfirm(button.dataset.provider, button.dataset.env, button.dataset.name)));
  document.querySelectorAll('.split-toggle').forEach((toggle) => toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = toggle.parentElement.querySelector('.split-menu');
    const willOpen = menu.hidden;
    document.querySelectorAll('.split-menu').forEach((m) => { m.hidden = true; });
    menu.hidden = !willOpen;
  }));
  document.querySelectorAll('.stop-button,.start-button').forEach((button) => button.addEventListener('click', async () => {
    document.querySelectorAll('.split-menu').forEach((m) => { m.hidden = true; });
    const action = button.classList.contains('stop-button') ? 'stop' : 'start';
    button.disabled = true;
    const prev = button.textContent;
    button.textContent = action === 'stop' ? '停止中…' : '起動中…';
    try {
      const result = await fetch(`/api/environments/${button.dataset.provider}/${encodeURIComponent(button.dataset.env)}/${action}`, { method: 'POST' });
      const data = await result.json().catch(() => ({}));
      if (result.ok) { notify(action === 'stop' ? '停止しました' : '起動しました'); setTimeout(loadConnectedEnvironments, 2000); }
      else notify(data.message || `${action}に失敗しました`);
    } catch { notify('サーバーに接続できません'); }
    finally { button.disabled = false; button.textContent = prev; }
  }));
}
bindEnvironmentActions();
const deleteDialog = document.querySelector('#deleteConfirmDialog');
let deleteTarget = null;
function openDeleteConfirm(provider, id, name) {
  deleteTarget = { provider, id };
  document.querySelector('#deleteEnvInfo').textContent = `「${name || id}」を削除します。この操作は元に戻せません。`;
  deleteDialog.showModal();
}
document.querySelector('#cancelDelete').addEventListener('click', () => deleteDialog.close());
document.querySelector('#confirmDelete').addEventListener('click', async () => {
  if (!deleteTarget) return;
  const { provider, id } = deleteTarget;
  const button = document.querySelector('#confirmDelete');
  button.disabled = true;
  button.textContent = '削除中...';
  try {
    const result = await fetch(`/api/environments/${provider}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await result.json();
    if (result.ok) { notify('環境を削除しました'); deleteDialog.close(); setTimeout(loadConnectedEnvironments, 800); }
    else notify(data.message || '削除に失敗しました');
  } catch { notify('サーバーに接続できません'); }
  finally { button.disabled = false; button.textContent = '削除する'; }
});
function renderOpenCodeBadge(badge, state) {
  if (!badge) return;
  badge.className = `opencode-status os-${state.state}`;
  if (state.state === 'running') {
    const running = state.opencode === 'running';
    const auth = state.auth
      ? `<span class="os-pw">ID <code>${state.auth.username}</code></span><span class="os-copy-row"><button type="button" class="os-copy" data-copy="user" data-user="${state.auth.username}">IDをコピー</button></span><span class="os-pw">PASS <code>${state.auth.password}</code></span><span class="os-copy-row"><button type="button" class="os-copy" data-copy="pw" data-pw="${state.auth.password}">パスワードをコピー</button></span>`
      : '';
    const status = running
      ? `<span class="os-badge running">● 稼働中${state.version ? ` <em style="font-style:normal;opacity:.7">v${state.version}</em>` : ''}</span>`
      : state.opencode === 'error'
        ? `<span class="os-badge failed">● エラー</span><span class="os-error">${state.opencodeDetail || 'opencodeが未応答です'}</span>`
        : `<span class="os-badge checking">◐ opencodeは使用できます</span><span class="os-detail">Codespaceは起動済み。公開URLからBasic認証で接続できます。</span>`;
    badge.innerHTML = `${status}<a class="os-url" href="${state.publicUrl}" target="_blank" rel="noopener">開く ↗</a><span class="os-copy-row"><button type="button" class="os-copy" data-copy="url" data-url="${state.publicUrl}">URLをコピー</button></span>${auth}`;
  } else if (state.state === 'starting') {
    badge.innerHTML = `<span class="os-badge starting">◐ 起動中…</span><span class="os-detail">${state.detail || '準備中…'}</span>`;
  } else if (state.state === 'stopped') {
    badge.innerHTML = `<span class="os-badge stopped">● 停止</span>`;
  } else if (state.state === 'failed') {
    badge.innerHTML = `<span class="os-badge failed">● 失敗</span><span class="os-error">${state.error || ''}</span>`;
  }
}
async function launchOpenCode(environmentId) {
  if (!environmentId) return notify('起動対象の環境がありません');
  const badge = document.querySelector(`.opencode-status[data-env="${environmentId}"]`);
  if (badge) { badge.className = `opencode-status os-starting`; badge.innerHTML = `<span class="os-badge starting">◐ 起動中…</span><span class="os-detail">リクエスト送信中…</span>`; }
  try {
    const result = await fetch('/api/opencode/serve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environmentId }) });
    const data = await result.json().catch(() => ({}));
    if (result.ok) {
      notify(data.status === 'running' ? 'OpenCodeは既に起動しています' : 'Codespaceを起動しています（通常1〜2分）...');
      if (data.status === 'running') renderOpenCodeBadge(badge, { state: 'running', publicUrl: data.publicUrl });
      else if (badge) badge.innerHTML = `<span class="os-badge starting">◐ 起動中…</span><span class="os-detail">${data.detail || '準備中…'}</span>`;
      pollServeStatus();
    } else {
      if (badge) badge.innerHTML = `<span class="os-badge failed">● 失敗</span><span class="os-error">${data.message || 'OpenCodeを起動できません'}</span>`;
      notify(data.message || 'OpenCodeを起動できません');
    }
  } catch { notify('サーバーに接続できません'); }
}

const serveCheckNote = document.querySelector('#serveCheckNote');
let serveStatusPolled = false;
async function pollServeStatus() {
  const badges = [...document.querySelectorAll('.opencode-status[data-env]')];
  const ids = badges.map((b) => b.dataset.env).filter(Boolean);
  if (!ids.length) { serveCheckNote.hidden = true; return; }
  if (!serveStatusPolled) serveCheckNote.hidden = false;
  try {
    const result = await fetch(`/api/opencode/status?ids=${encodeURIComponent(ids.join(','))}`);
    const data = await result.json();
    if (data.vercel) isVercel = true;
    const known = new Set((data.states || []).map((s) => s.environmentId));
    (data.states || []).forEach((state) => renderOpenCodeBadge(document.querySelector(`.opencode-status[data-env="${state.environmentId}"]`), state));
    if (serveStatusPolled) {
      document.querySelectorAll('.opencode-status[data-env]').forEach((badge) => {
        if (!known.has(badge.dataset.env)) {
          badge.className = 'opencode-status os-idle';
          badge.innerHTML = `<span class="os-badge idle">未起動</span>`;
        }
      });
    }
    serveStatusPolled = true;
  } catch { /* ignore */ }
  finally { serveCheckNote.hidden = true; }
}
setInterval(pollServeStatus, 5000);
pollServeStatus();
document.querySelector('#environmentList').addEventListener('click', (event) => {
  const copy = event.target.closest('.os-copy');
  if (!copy) return;
  const text = copy.dataset.copy === 'pw' ? copy.dataset.pw : copy.dataset.copy === 'user' ? copy.dataset.user : copy.dataset.url;
  const label = copy.dataset.copy === 'pw' ? 'パスワードをコピーしました' : copy.dataset.copy === 'user' ? 'ユーザー名をコピーしました' : 'URLをコピーしました';
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => notify(label)).catch(() => notify('コピーに失敗しました')); }
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); notify(label); }
});
document.querySelectorAll('.filter').forEach((filter) => filter.addEventListener('click', () => { document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active')); filter.classList.add('active'); const mode = filter.textContent.toLowerCase(); document.querySelectorAll('.environment-card').forEach((card) => { card.style.display = mode === 'all' || (mode === 'running' && card.classList.contains('running')) || (mode === 'paused' && card.classList.contains('paused')) ? '' : 'none'; }); }));
document.querySelector('#refreshEnv').addEventListener('click', loadConnectedEnvironments);

let currentRefreshStartedAt = 0;
async function loadConnectedEnvironments() {
  const startedAt = Date.now();
  currentRefreshStartedAt = startedAt;
  const refreshButton = document.querySelector('#refreshEnv');
  refreshButton.classList.add('spinning');
  refreshButton.disabled = true;
  try {
    const config = await fetch('/api/config').then((response) => response.json());
    isVercel = !!config.vercel;
    const missing = [];
    if (!config.configured.codespaces) missing.push('GITHUB_CODESPACES_TOKEN');
    const alert = document.querySelector('#configAlert');
    if (missing.length) {
      alert.hidden = false;
      const hint = isVercel ? 'Vercelのプロジェクト設定（Environment Variables）に設定してください。' : '.env.local を設定してサーバーを再起動してください。';
      alert.innerHTML = `<strong>設定が必要です</strong><span>${missing.join(' / ')} が未設定です。${hint}</span><button class="primary-button" onclick="document.querySelector('#setupDialog').showModal()">設定手順を見る</button>`;
    } else alert.hidden = true;
    const result = await fetch('/api/environments');
    const data = await result.json();
    if (data.errors?.length) notify(`${data.errors.join(' / ')} の取得に失敗しました。トークンの権限や有効期限を確認してください。`);
    document.querySelector('#environmentCount').textContent = String(data.environments?.length ?? 0);
    if (!data.environments?.length) { document.querySelector('#environmentList').innerHTML = `<div class="empty-state"><strong>環境がありません</strong><span>${Object.values(config.configured).some(Boolean) ? '接続先に環境が見つかりませんでした。GitHub側でCodespaceを作成するか、トークンの権限を確認してください。' : 'トークンが未設定のため表示できません。'}</span><div class="empty-actions"><button class="primary-button" onclick="document.querySelector('#setupDialog').showModal()">設定を開く</button><button class="ghost-button" id="emptyRetry">再読み込み</button></div></div>`; document.querySelector('#emptyRetry').addEventListener('click', loadConnectedEnvironments); return; }
    const list = document.querySelector('#environmentList');
    list.innerHTML = data.environments.map((item) => {
      const running = String(item.state).toLowerCase().includes('run') || ['available', 'active'].includes(String(item.state).toLowerCase());
      const launchButtons = running
        ? `<button class="stop-button" data-provider="github" data-env="${item.id}">停止</button><button class="opencode-button" data-env="${item.id}">起動</button>`
        : `<span class="split-group"><button class="opencode-button" data-env="${item.id}">起動</button><button class="split-toggle" aria-label="その他の起動方法">▾</button><span class="split-menu" hidden><button class="start-button" data-provider="github" data-env="${item.id}">codespaceのみ起動</button></span></span>`;
      return `<article class="environment-card ${running ? 'running' : 'paused'}"><div class="card-top"><div class="provider-icon github">◖</div><div class="env-title"><h3>${item.name}</h3><div class="meta"><span class="pill ${running ? 'live' : 'pause'}">● ${running ? 'Running' : 'Paused'}</span><span>${item.provider}</span></div></div></div><div class="branch">⌁ ${item.repository || '-'} <span>·</span> ${item.branch || '-'}</div><div class="opencode-status" data-env="${item.id}"></div><div class="card-bottom"><div class="agent"><span class="agent-dot">✦</span><span>${item.updatedAt ? new Date(item.updatedAt).toLocaleString('ja-JP') : 'Ready'}</span></div><div class="card-actions">${launchButtons}<button class="open-button" data-env="${item.id}" data-url="${item.url || ''}">Open workspace <span>↗</span></button><button class="delete-button" data-provider="github" data-env="${item.id}" data-name="${item.name}">削除</button></div></div></article>`;
    }).join('');
bindEnvironmentActions();
// Splitメニューは一覧再描画で作り直されるため、閉じる処理は document に1度だけ登録する
document.addEventListener('click', (event) => {
  if (!event.target.closest('.split-group')) document.querySelectorAll('.split-menu').forEach((m) => { m.hidden = true; });
});
    pollServeStatus();
  } catch (error) {
    document.querySelector('#environmentList').innerHTML = `<div class="empty-state"><strong>読込に失敗しました</strong><span>${error instanceof Error ? error.message : 'サーバーに接続できません'}</span><div class="empty-actions"><button class="ghost-button" onclick="loadConnectedEnvironments()">再読み込み</button></div></div>`;
  } finally {
    if (currentRefreshStartedAt === startedAt) {
      setTimeout(() => { refreshButton.classList.remove('spinning'); refreshButton.disabled = false; }, 400);
      document.querySelector('#lastUpdated').textContent = `最後の更新: ${new Date().toLocaleTimeString('ja-JP')}`;
    }
  }
}
loadConnectedEnvironments();
setInterval(() => { if (!document.hidden) loadConnectedEnvironments(); }, 30000);

// 監視中（在室）スイッチ。ON=ユーザーが監視中（自動停止しない）、OFF=不在（全セッション完了時に
// Codespace内の監視ループが自動停止する）。状態は GitHub の opencode-workspace リポジトリ（presence ブランチ）の presence.json に保存される。
let presenceBusy = false;
async function loadPresence() {
  const toggle = document.querySelector('#presenceToggle');
  const stateEl = document.querySelector('#presenceState');
  const hintEl = document.querySelector('#presenceHint');
  if (!toggle) return;
  try {
    const res = await fetch('/api/presence');
    const data = await res.json().catch(() => ({}));
    toggle.checked = data.monitoring !== false;
    if (data.configured === false) { toggle.disabled = true; hintEl.textContent = 'GITHUB_PRESENCE_TOKEN未設定'; }
    else { toggle.disabled = false; hintEl.textContent = toggle.checked ? 'ON: 自動停止しない' : 'OFF: 自動停止が有効'; }
    stateEl.textContent = toggle.checked ? '監視中' : '不在';
  } catch {
    toggle.disabled = true; hintEl.textContent = '取得できません';
  }
}
document.querySelector('#presenceToggle')?.addEventListener('change', async (event) => {
  const monitoring = event.target.checked;
  if (presenceBusy) return;
  presenceBusy = true;
  const toggle = event.target; const stateEl = document.querySelector('#presenceState'); const hintEl = document.querySelector('#presenceHint');
  toggle.disabled = true;
  try {
    const res = await fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monitoring }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      stateEl.textContent = monitoring ? '監視中' : '不在';
      hintEl.textContent = monitoring ? 'ON: 自動停止しない' : 'OFF: 自動停止が有効';
      toggle.checked = monitoring;
      notify(monitoring ? '監視中に設定しました' : '不在に設定しました（自動停止有効）');
    } else {
      toggle.checked = !monitoring; notify(data.message || '更新に失敗しました');
    }
  } catch { toggle.checked = !monitoring; notify('サーバーに接続できません'); }
  finally { toggle.disabled = false; presenceBusy = false; }
});
loadPresence();