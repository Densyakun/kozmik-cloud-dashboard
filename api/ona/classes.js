import { getProviders, onaApi } from './_lib/index.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!getProviders().ona) return res.status(400).json({ message: 'ONA_PERSONAL_ACCESS_TOKEN が設定されていません。' });
  try {
    const data = await onaApi('EnvironmentService/ListEnvironmentClasses', {});
    const classes = (data.environmentClasses || []).filter((c) => c.enabled !== false).map((c) => ({ id: c.id, name: c.displayName || c.id, description: c.description || c.id, runnerId: c.runnerId }));
    res.status(200).json({ classes });
  } catch (e) { res.status(502).json({ message: `Ona Cloudのマシンクラス取得に失敗しました。${e.message || ''}` }); }
}
