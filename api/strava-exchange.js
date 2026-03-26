// api/strava-exchange.js
// Vercel serverless function — handles Strava OAuth token exchange securely
// The client secret never touches the browser

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, action, refresh_token } = req.body;

  const CLIENT_ID = '216800';
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET; // set in Vercel env vars

  try {
    let body;
    if (action === 'refresh') {
      body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token,
      });
    } else {
      body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      });
    }

    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data.message || 'Strava error' });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
