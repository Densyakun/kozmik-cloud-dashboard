import { getProviders, github, isAuthenticated } from '../../../_lib/index.js';
export default async function handler(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });
  if (req.method !== 'DELETE') { res.setHeader('Allow', 'DELETE'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { provider, id } = req.query;
  if (provider === 'github') {
    if (!getProviders().codespaces) return res.status(400).json({ message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
    try { await github(`/user/codespaces/${encodeURIComponent(id)}`, { method: 'DELETE' }); return res.status(200).json({ ok: true }); }
    catch { return res.status(502).json({ message: 'Codespacesの削除に失敗しました。' }); }
  }
  res.status(400).json({ message: '不明なプロバイダーです' });
}
