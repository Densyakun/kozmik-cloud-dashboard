import { github, isAuthenticated, describeCodespaceState, codespaceForwardUrl, opencodeCredentials, probeOpenCodeHealth } from '../_lib/index.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ids = (parsed.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const states = await Promise.all(ids.map(async (environmentId) => {
    try {
      const codespace = await github(`/user/codespaces/${encodeURIComponent(environmentId)}`);
      const { kind } = describeCodespaceState(codespace.state);
      const base = { environmentId, name: codespace.display_name || codespace.name || environmentId, codespaceState: codespace.state };
      const publicUrl = codespaceForwardUrl(environmentId);
      if (kind === 'running') {
        // CodespaceはRunningでも opencode の起動が追いついていないことがあるため、公開URLへヘルスチェックする
        const health = await probeOpenCodeHealth(publicUrl);
        const opencode = health.healthy ? 'running' : health.httpCode === 0 ? 'starting' : 'error';
        return {
          ...base,
          state: 'running',
          publicUrl,
          auth: opencodeCredentials(),
          opencode,
          version: health.version || undefined,
          opencodeDetail: opencode === 'running'
            ? 'opencodeが応答しています'
            : opencode === 'starting'
              ? 'opencodeは起動済みです。公開URLからBasic認証で接続できます。'
              : `opencodeが未応答です（HTTP ${health.httpCode}）。しばらく待ってから再読み込みしてください。`,
        };
      }
      if (kind === 'starting') return { ...base, state: 'starting', detail: 'Codespaceを起動しています…（通常1〜2分）', publicUrl };
      if (kind === 'stopped') return { ...base, state: 'stopped' };
      return { ...base, state: 'failed', error: `Codespaceが不正な状態です（state: ${codespace.state}）` };
    } catch {
      return { environmentId, state: 'failed', error: 'Codespaceの状態を取得できませんでした。トークンの権限と有効期限を確認してください。', codespaceState: null };
    }
  }));
  res.status(200).json({ states, vercel: true });
}