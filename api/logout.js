export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'kcd_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.status(200).json({ ok: true });
}
