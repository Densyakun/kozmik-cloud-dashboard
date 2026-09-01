import { getDashboardPassword, getDashboardToken } from './_lib/index.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const pw = getDashboardPassword();
  if (!pw) return res.status(200).json({ ok: true });
  let body = req.body;
  if (!body || typeof body !== 'object') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    body = raw ? JSON.parse(raw) : {};
  }
  if (String(body.password || '') === pw) {
    const token = getDashboardToken();
    res.setHeader('Set-Cookie', `kcd_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.status(200).json({ ok: true });
  }
  res.status(401).json({ message: 'パスワードが正しくありません' });
}
