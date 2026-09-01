import { getProviders, isAuthenticated } from './_lib/index.js';
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ message: '認証が必要です', code: 'unauthorized' });
  res.status(200).json({ providers: getProviders() });
}
