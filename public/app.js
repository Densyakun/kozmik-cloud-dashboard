const toast = document.querySelector('#toast');
function notify(message) { toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2600); }
const newEnvDialog = document.querySelector('#newEnvDialog');
document.querySelector('#cancelNewEnv').addEventListener('click', () => newEnvDialog.close());
document.querySelector('#openSettings').addEventListener('click', () => document.querySelector('#setupDialog').showModal());
let newEnvProvider = 'github';
function setNewEnvProvider(provider) {
  newEnvProvider = provider;
  document.querySelectorAll('#providerSelect .provider-option').forEach((btn) => btn.classList.toggle('active', btn.dataset.provider === provider));
  const isOna = provider === 'ona';
  document.querySelector('#githubRepoField').hidden = isOna;
  document.querySelector('#onaRepoField').hidden = !isOna;
  document.querySelector('#onaClassField').hidden = !isOna;
  if (isOna) loadOnaClasses();
}
document.querySelectorAll('#providerSelect .provider-option').forEach((btn) => btn.addEventListener('click', () => setNewEnvProvider(btn.dataset.provider)));
document.querySelector('#newEnvForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#envName').value.trim();
  const button = document.querySelector('#submitNewEnv');
  button.disabled = true;
  button.textContent = '作成中...';
  const errorBox = document.querySelector('#newEnvError');
  errorBox.hidden = true;
  try {
    let result;
    if (newEnvProvider === 'ona') {
      const body = { provider: 'ona', repoUrl: document.querySelector('#onaRepoUrl').value.trim(), machineClass: document.querySelector('#onaMachineClass').value, name: name || undefined };
      result = await fetch('/api/environments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      const body = { provider: 'github', name: name || undefined };
      const repoOption = document.querySelector('#envRepo').selectedOptions[0];
      const repo = repoOption ? repoOption.value : '';
      if (repo !== '') { body.repositoryId = repoOption.dataset.id || undefined; body.repo = repo; }
      result = await fetch('/api/environments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    const data = await result.json();
    if (!result.ok) {
      errorBox.hidden = false;
      let actions = '';
      if (data.code === 'needs_subscription') actions = `<div class="dialog-actions"><a class="ghost-button" href="https://app.gitpod.io/settings/billing" target="_blank" rel="noopener">OnaのBilling設定を開く ↗</a></div>`;
      else if (newEnvProvider === 'ona') actions = `<div class="dialog-actions"><button type="button" class="ghost-button" onclick="document.querySelector('#newEnvDialog').close()">閉じる</button></div>`;
      else actions = `<div class="dialog-actions"><button type="button" class="ghost-button" onclick="document.querySelector('#setupDialog').showModal()">設定を開く</button><a class="ghost-button" href="https://github.com/new" target="_blank" rel="noopener">リポジトリ作成 ↗</a></div>`;
      errorBox.innerHTML = `<p>${data.message || '作成に失敗しました'}</p>${actions}`;
      return;
    }
    notify(`環境を作成しました: ${data.web_url || data.name || ''}`);
    newEnvDialog.close();
    setTimeout(loadConnectedEnvironments, 1500);
  } catch { notify('サーバーに接続できません'); }
  finally { button.disabled = false; button.textContent = '作成する'; }
});
async function loadRepos() {
  const select = document.querySelector('#envRepo');
  select.innerHTML = '<option value="">読み込み中...</option>';
  try {
    const result = await fetch('/api/repos');
    const data = await result.json();
    if (!result.ok) { select.innerHTML = `<option value="">${data.message || '取得できません'}</option>`; return; }
    if (!data.repos?.length) { select.innerHTML = '<option value="">リポジトリありません</option>'; return; }
    select.innerHTML = data.repos.map((item) => `<option value="${item.fullName}" data-id="${item.id}">${item.fullName}${item.private ? ' (private)' : ''}</option>`).join('');
  } catch { select.innerHTML = '<option value="">取得に失敗しました</option>'; }
}
async function loadOnaClasses() {
  const select = document.querySelector('#onaMachineClass');
  select.innerHTML = '<option value="">読み込み中...</option>';
  try {
    const result = await fetch('/api/ona/classes');
    const data = await result.json();
    if (!result.ok) { select.innerHTML = `<option value="">${data.message || '取得できません'}</option>`; return; }
    if (!data.classes?.length) { select.innerHTML = '<option value="">利用可能なクラスがありません</option>'; return; }
    select.innerHTML = data.classes.map((c) => `<option value="${c.id}">${c.name} — ${c.description}</option>`).join('');
  } catch { select.innerHTML = '<option value="">取得に失敗しました</option>'; }
}
document.querySelector('#refreshRepos').addEventListener('click', loadRepos);
document.querySelector('#newProject').addEventListener('click', () => { loadRepos(); setNewEnvProvider('github'); newEnvDialog.showModal(); });
function bindEnvironmentActions() {
  document.querySelectorAll('.open-button').forEach((button) => button.addEventListener('click', () => { if (button.dataset.url) window.open(button.dataset.url, '_blank', 'noopener'); else notify(`${button.dataset.env} のワークスペースを開いています`); }));
  document.querySelectorAll('.opencode-button').forEach((button) => button.addEventListener('click', async () => { await launchOpenCode(button.dataset.env); }));
  document.querySelectorAll('.delete-button').forEach((button) => button.addEventListener('click', () => openDeleteConfirm(button.dataset.provider, button.dataset.env, button.dataset.name)));
  document.querySelectorAll('.stop-button,.start-button').forEach((button) => button.addEventListener('click', async () => {
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
async function launchOpenCode(environmentId) {
  if (!environmentId) return notify('起動対象の環境がありません');
  const badge = document.querySelector(`.opencode-status[data-env="${environmentId}"]`);
  if (badge) { badge.className = `opencode-status os-starting`; badge.innerHTML = `<span class="os-badge starting">◐ 起動中…</span><span class="os-detail">リクエスト送信中…</span>`; }
  try {
    const result = await fetch('/api/opencode/serve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environmentId }) });
    const data = await result.json();
    if (result.ok) notify(data.status === 'running' ? 'OpenCodeは既に起動しています' : 'OpenCode serve を起動しています（転送含め数分かかります）...');
    else notify(data.message || 'OpenCodeを起動できません');
  } catch { notify('サーバーに接続できません'); }
}

const serveCheckNote = document.querySelector('#serveCheckNote');
let serveStatusPolled = false;
async function pollServeStatus() {
  if (!serveStatusPolled) serveCheckNote.hidden = false;
  try {
    const result = await fetch('/api/opencode/status');
    const data = await result.json();
    const known = new Set((data.states || []).map((s) => s.environmentId));
    (data.states || []).forEach((state) => {
      const badge = document.querySelector(`.opencode-status[data-env="${state.environmentId}"]`);
      if (!badge) return;
      badge.className = `opencode-status os-${state.state}`;
      badge.dataset.env = state.environmentId;
      if (state.state === 'running') {
        badge.innerHTML = `<span class="os-badge running">● 稼働中</span><a class="os-url" href="${state.publicUrl}" target="_blank" rel="noopener">開く ↗</a><span class="os-pw">ユーザー名: <code>${state.username || 'opencode'}</code> パスワード: <code>${state.password}</code></span><span class="os-copy-row"><button type="button" class="os-copy" data-copy="url" data-url="${state.publicUrl}">URLをコピー</button><button type="button" class="os-copy" data-copy="pw" data-pw="${state.password}">パスワードをコピー</button></span>`;
      } else if (state.state === 'starting') {
        badge.innerHTML = `<span class="os-badge starting">◐ 起動中…</span><span class="os-detail">${state.detail || '準備中…'}</span>`;
      } else if (state.state === 'stopped') {
        badge.innerHTML = `<span class="os-badge stopped">● 停止</span>`;
      } else if (state.state === 'failed') {
        badge.innerHTML = `<span class="os-badge failed">● 失敗</span><span class="os-error">${state.error || ''}</span>`;
      }
    });
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
  const text = copy.dataset.copy === 'pw' ? copy.dataset.pw : copy.dataset.url;
  const label = copy.dataset.copy === 'pw' ? 'パスワードをコピーしました' : 'URLをコピーしました';
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => notify(label)).catch(() => notify('コピーに失敗しました')); }
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); notify(label); }
});
document.querySelector('#copyServe').addEventListener('click', () => { const url = document.querySelector('#serveUrl').textContent; if (navigator.clipboard && url !== '—') { navigator.clipboard.writeText(url).then(() => notify('URLをコピーしました')); } });
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
    const missing = [];
    if (!config.configured.codespaces) missing.push('GITHUB_CODESPACES_TOKEN');
    if (!config.configured.ona) missing.push('ONA_PERSONAL_ACCESS_TOKEN');
    if (!config.configured.opencode) missing.push('OPENCODE_API_KEY');
    const alert = document.querySelector('#configAlert');
    if (missing.length) {
      alert.hidden = false;
      alert.innerHTML = `<strong>設定が必要です</strong><span>${missing.join(' / ')} が未設定です。.env.local を設定してサーバーを再起動してください。</span><button class="primary-button" onclick="document.querySelector('#setupDialog').showModal()">設定手順を見る</button>`;
    } else alert.hidden = true;
    const result = await fetch('/api/environments');
    const data = await result.json();
    if (data.errors?.length) notify(`${data.errors.join(' / ')} の取得に失敗しました。トークンの権限や有効期限を確認してください。`);
    document.querySelector('#environmentCount').textContent = String(data.environments?.length ?? 0);
    if (!data.environments?.length) { document.querySelector('#environmentList').innerHTML = `<div class="empty-state"><strong>環境がありません</strong><span>${Object.values(config.configured).some(Boolean) ? '接続先に環境が見つかりませんでした。GitHub/Ona側でCodespace/Environmentを作成するか、トークンの権限を確認してください。' : 'トークンが未設定のため表示できません。'}</span><div class="empty-actions"><button class="primary-button" onclick="document.querySelector('#setupDialog').showModal()">設定を開く</button><button class="ghost-button" id="emptyRetry">再読み込み</button></div></div>`; document.querySelector('#emptyRetry').addEventListener('click', loadConnectedEnvironments); return; }
    const list = document.querySelector('#environmentList');
    list.innerHTML = data.environments.map((item) => {
      const running = String(item.state).toLowerCase().includes('run') || ['available', 'active'].includes(String(item.state).toLowerCase());
      const opencodeButton = item.providerId === 'github' ? `<button class="opencode-button" data-env="${item.id}">OpenCode起動</button>` : '';
      const opencodeStatus = item.providerId === 'github' ? `<div class="opencode-status" data-env="${item.id}"></div>` : '';
      const stopButton = item.providerId === 'github' ? (running ? `<button class="stop-button" data-provider="${item.providerId}" data-env="${item.id}">停止</button>` : `<button class="start-button" data-provider="${item.providerId}" data-env="${item.id}">起動</button>`) : '';
      return `<article class="environment-card ${running ? 'running' : 'paused'}"><div class="card-top"><div class="provider-icon ${item.providerId === 'github' ? 'github' : 'ona'}">${item.providerId === 'github' ? '◖' : 'ona'}</div><div class="env-title"><h3>${item.name}</h3><div class="meta"><span class="pill ${running ? 'live' : 'pause'}">● ${running ? 'Running' : 'Paused'}</span><span>${item.provider}</span></div></div></div><div class="branch">⌁ ${item.repository || '-'} <span>·</span> ${item.branch || '-'}</div>${opencodeStatus}<div class="card-bottom"><div class="agent"><span class="agent-dot">✦</span><span>${item.updatedAt ? new Date(item.updatedAt).toLocaleString('ja-JP') : 'Ready'}</span></div><div class="card-actions">${opencodeButton}${stopButton}<button class="open-button" data-env="${item.id}" data-url="${item.url || ''}">Open workspace <span>↗</span></button><button class="delete-button" data-provider="${item.providerId}" data-env="${item.id}" data-name="${item.name}">削除</button></div></div></article>`;
    }).join('');
    bindEnvironmentActions();
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
