import { getProviders, github, isAuthenticated } from './_lib/index.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });
  if (!getProviders().codespaces) return res.status(400).json({ message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
  try {
    const data = await github('/user/repos?per_page=100&visibility=all&sort=updated');
    res.status(200).json({ repos: (data || []).map((item) => ({ id: item.id, fullName: item.full_name, private: item.private })) });
  } catch (e) { res.status(502).json({ message: e.message || 'リポジトリ一覧の取得に失敗しました。' }); }
}
