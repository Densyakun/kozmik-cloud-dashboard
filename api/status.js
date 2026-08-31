import { getProviders } from './_lib/index.js';
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ providers: getProviders() });
}
