export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  res.status(501).json({
    code: 'not_available_on_vercel',
    message: 'OpenCodeのSSHトンネル起動はVercelでは利用できません。Vercelはステートレスなため、代わりにリポジトリの .devcontainer に forwardPorts と opencode 起動を設定し、Codespacesの公開URL https://<codespace>-4096.app.github.dev を利用してください。詳細はREADMEの「Vercelへのデプロイについて」を参照してください。',
  });
}
