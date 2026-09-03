import { describeCodespaceState, getProviders, github, isAuthenticated } from '../../../_lib/index.js';
export default async function handler(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const { provider, id, action } = req.query;
  if (provider !== 'github' || !['start', 'stop'].includes(action)) return res.status(400).json({ message: 'この操作は現在GitHub Codespacesで利用できます。' });
  if (!getProviders().codespaces) return res.status(400).json({ message: 'GITHUB_CODESPACES_TOKEN が設定されていません。' });
  try {
    const data = await github(`/user/codespaces/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    res.status(200).json(data || { ok: true });
  } catch (error) {
    const reason = error.message || '';
    if (action === 'stop') {
      // 起動中は停止APIが拒否される場合がある。現在の状態を確認して案内する
      try {
        const codespace = await github(`/user/codespaces/${encodeURIComponent(id)}`);
        const { kind } = describeCodespaceState(codespace.state);
        if (kind === 'stopped') return res.status(200).json({ ok: true, state: codespace.state });
        if (kind === 'starting') return res.status(409).json({ message: 'Codespaceが起動中です。起動完了（Running）後に停止してください。', state: codespace.state });
      } catch { /* 状態取得できなければ通常のエラーとして返す */ }
    }
    res.status(502).json({ message: `Codespaces APIで操作できませんでした。${reason}` });
  }
}
