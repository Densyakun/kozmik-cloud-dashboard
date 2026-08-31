import { getProviders, github, onaApi, normalizeGithub } from './_lib/index.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const providers = getProviders();
  if (req.method === 'GET') {
    const environments = [];
    const errors = [];
    if (providers.codespaces) {
      try { const data = await github('/user/codespaces?per_page=100'); environments.push(...(data.codespaces || []).map(normalizeGithub)); } catch { errors.push('GitHub Codespaces'); }
    }
    if (providers.ona) {
      try {
        const data = await onaApi('EnvironmentService/ListEnvironments', {});
        environments.push(...(data.environments || []).map((item) => ({ id: item.id, name: item.displayName || item.metadata?.name || item.id, provider: 'Ona Cloud', providerId: 'ona', state: item.status?.phase || item.phase || 'ENVIRONMENT_PHASE_UNSPECIFIED', branch: item.spec?.content?.initializer?.specs?.[0]?.git?.cloneTarget || 'main', repository: item.metadata?.originalContextUrl || '-', url: item.status?.environmentUrls?.web || item.url, updatedAt: item.metadata?.lastStartedAt || item.updatedAt })));
      } catch (e) { console.error('ona error:', e.message); errors.push('Ona Cloud'); }
    }
    return res.status(200).json({ environments, errors });
  }
  if (req.method === 'POST') {
    let body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    }
    if (body.provider === 'ona') {
      if (!providers.ona) return res.status(400).json({ message: 'ONA_PERSONAL_ACCESS_TOKEN が設定されていません。' });
      const repoUrl = String(body.repoUrl || '').trim();
      const machineClass = String(body.machineClass || '').trim();
      if (!repoUrl) return res.status(400).json({ message: 'リポジトリのURLを入力してください。' });
      if (!machineClass) return res.status(400).json({ message: 'マシンクラスを選択してください。' });
      try {
        const spec = { spec: { specVersion: '1', machine: { class: machineClass }, content: { initializer: { specs: [{ contextUrl: { url: repoUrl } }] } } } };
        if (body.name) spec.name = String(body.name);
        const payload = await onaApi('EnvironmentService/CreateEnvironment', spec);
        const item = payload.environment || {};
        return res.status(201).json({ id: item.id, name: body.name || item.id, repository: repoUrl, state: item.status?.phase || 'ENVIRONMENT_PHASE_UNSPECIFIED', url: item.status?.environmentUrls?.web || null });
      } catch (e) {
        const reason = e.message || '';
        const billing = /subscription/i.test(reason);
        const guide = billing ? 'このアカウントの組織はアクティブな契約がありません。Onaコンソールの「Settings > Billing」で契約を開始してください。' : '';
        return res.status(billing ? 403 : 502).json({ code: billing ? 'needs_subscription' : 'create_failed', message: `Ona Cloudの環境作成に失敗しました。${guide}${reason}` });
      }
    }
    if (!providers.codespaces) return res.status(400).json({ message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
    if (!body.repositoryId && !body.repo) return res.status(400).json({ message: 'リポジトリが必要です。自分のリポジトリを選ぶか、GitHubで先にリポジトリを作成してください。' });
    try {
      let repositoryId = body.repositoryId;
      let repoName = body.repo;
      let defaultBranch = null;
      if (body.repo) {
        const [owner, repo] = String(body.repo).split('/');
        if (owner && repo) {
          const repoInfo = await github(`/repos/${owner}/${repo}`);
          repositoryId = repoInfo.id; repoName = repoInfo.full_name || body.repo; defaultBranch = repoInfo.default_branch || null;
        } else return res.status(400).json({ message: 'リポジトリは owner/repo 形式で入力してください。' });
      }
      const numericId = Number(repositoryId);
      if (!Number.isInteger(numericId) || numericId <= 0) return res.status(400).json({ message: 'リポジトリIDが不正です。' });
      const createBody = { repository_id: numericId };
      const branch = body.ref || defaultBranch;
      if (branch) createBody.ref = branch;
      if (body.name) createBody.display_name = body.name;
      if (body.machine) createBody.machine = body.machine;
      const payload = await github('/user/codespaces', { method: 'POST', body: JSON.stringify(createBody), headers: { 'Content-Type': 'application/json' } });
      return res.status(201).json({ id: payload.name, name: payload.display_name || payload.name, repository: repoName || null, web_url: payload.web_url, state: payload.state });
    } catch (e) {
      const reason = e.message || '';
      let hint = '';
      if (e.status === 403) hint = 'トークンがこのリポジトリにアクセスできないか、権限がありません。';
      return res.status(502).json({ message: `Codespacesの作成に失敗しました。${hint}${reason}` });
    }
  }
  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ message: 'Method Not Allowed' });
}
