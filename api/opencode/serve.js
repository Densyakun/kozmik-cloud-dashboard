import { github, isAuthenticated, readJson, describeCodespaceState, codespaceForwardUrl } from '../_lib/index.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ message: 'リクエストボディが不正です' }); }
  const environmentId = String(body.environmentId || '');
  if (!environmentId) return res.status(400).json({ message: '起動対象の環境が指定されていません。' });
  try {
    // CodespaceをREST APIで起動（非同期。opencode自体はCodespace内のdevcontainerで常駐起動済み）
    const codespace = await github(`/user/codespaces/${encodeURIComponent(environmentId)}`);
    const { kind } = describeCodespaceState(codespace.state);
    const publicUrl = codespaceForwardUrl(environmentId);
    if (kind === 'stopped') {
      // start API は非同期。完了（Running）は1〜2分後なので、フロントエンドのポーリングで状態遷移を監視する
      await github(`/user/codespaces/${encodeURIComponent(environmentId)}/start`, { method: 'POST' });
    }
    if (kind === 'running') return res.status(200).json({ status: 'running', environmentId, publicUrl, codespaceState: codespace.state });
    if (kind === 'failed') return res.status(409).json({ status: 'failed', environmentId, codespaceState: codespace.state, message: 'Codespaceが利用できない状態です。環境の削除や再作成を検討してください。' });
    return res.status(202).json({ status: 'starting', environmentId, publicUrl, codespaceState: codespace.state, detail: 'Codespaceを起動しています…（通常1〜2分）' });
  } catch (error) {
    return res.status(502).json({ message: `OpenCodeを起動できませんでした。${error.message || ''}` });
  }
}