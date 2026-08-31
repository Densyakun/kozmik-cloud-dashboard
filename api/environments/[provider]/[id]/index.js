import { getProviders, github, onaApi } from '../../_lib/index.js';
export default async function handler(req, res) {
  if (req.method !== 'DELETE') { res.setHeader('Allow', 'DELETE'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { provider, id } = req.query;
  if (provider === 'github') {
    if (!getProviders().codespaces) return res.status(400).json({ message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
    try { await github(`/user/codespaces/${encodeURIComponent(id)}`, { method: 'DELETE' }); return res.status(200).json({ ok: true }); }
    catch { return res.status(502).json({ message: 'Codespacesの削除に失敗しました。' }); }
  }
  if (provider === 'ona') {
    if (!getProviders().ona) return res.status(400).json({ message: 'ONA_PERSONAL_ACCESS_TOKEN が設定されていません。' });
    try { await onaApi('EnvironmentService/DeleteEnvironment', { environmentId: id }); return res.status(200).json({ ok: true }); }
    catch (e) { return res.status(502).json({ message: `Ona Cloudの環境削除に失敗しました。${e.message || ''}` }); }
  }
  res.status(400).json({ message: '不明なプロバイダーです' });
}
