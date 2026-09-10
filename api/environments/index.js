import { getProviders, github, normalizeGithub, isAuthenticated } from '../_lib/index.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });
  const providers = getProviders();
  if (req.method === 'GET') {
    const environments = [];
    const errors = [];
    if (providers.codespaces) {
      try { const data = await github('/user/codespaces?per_page=100'); environments.push(...(data.codespaces || []).map(normalizeGithub)); } catch { errors.push('GitHub Codespaces'); }
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
    if (!providers.codespaces) return res.status(400).json({ message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
    if (!body.repositoryId && !body.repo) body.repo = 'Densyakun/opencode-workspace';
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
