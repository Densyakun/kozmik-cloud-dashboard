import { isAuthenticated, readPresence, writePresence, getPresenceToken } from './_lib/index.js';

// 監視中（在室）スイッチ。状態は GitHub の opencode-workspace リポジトリの
// presence ブランチに置く presence.json に保存され、Codespace 内の
// presence-monitor.sh が読み取って自動停止に利用する。
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });

  if (req.method === 'GET') {
    try {
      const presence = await readPresence();
      return res.status(200).json({ ...presence, configured: Boolean(getPresenceToken()) });
    } catch (error) {
      return res.status(502).json({ message: `presence の取得に失敗しました。${error.message || ''}` });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    }
    if (!getPresenceToken()) return res.status(400).json({ message: 'GITHUB_PRESENCE_TOKEN が設定されていません。監視スイッチは Codespace 内の自動停止に利用されます。' });
    try {
      const result = await writePresence(body.monitoring !== false);
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      return res.status(502).json({ message: `presence の更新に失敗しました。${error.message || ''}` });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ message: 'Method Not Allowed' });
}
