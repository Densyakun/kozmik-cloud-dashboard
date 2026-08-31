import { getProviders } from './_lib/index.js';
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const providers = getProviders();
  res.status(200).json({ configured: providers });
}
