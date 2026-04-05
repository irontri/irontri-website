export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  
  const ANON = process.env.SUPABASE_ANON_KEY;
  const URL = process.env.SUPABASE_URL;
  
  try {
    const r = await fetch(`${URL}/rest/v1/rpc/get_user_count`, {
      method: 'POST',
      headers: {
        'apikey': ANON,
        'Authorization': `Bearer ${ANON}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    const count = await r.json();
    res.status(200).json({ count });
  } catch (e) {
    res.status(500).json({ count: 265 });
  }
}
