import { getDashboardPassword, isAuthenticated } from '../_lib/index.js';
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const pw = getDashboardPassword();
  if (!pw) return res.status(200).json({ required: false, authenticated: true });
  res.status(200).json({ required: true, authenticated: isAuthenticated(req) });
}
