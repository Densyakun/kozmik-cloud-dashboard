export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ states: [], vercel: true, message: 'OpenCodeトンネルはVercelでは提供されません' });
}
