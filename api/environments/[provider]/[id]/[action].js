import { getProviders, github } from '../../../_lib/index.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { provider, id, action } = req.query;
  if (provider !== 'github' || !['start', 'stop'].includes(action)) return res.status(400).json({ message: 'この操作は現在GitHub Codespacesで利用できます。' });
  if (!getProviders().codespaces) return res.status(400).json({ message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
  try {
    const data = await github(`/user/codespaces/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    res.status(200).json(data || { ok: true });
  } catch { res.status(502).json({ message: 'Codespaces APIで操作できませんでした。' }); }
}
