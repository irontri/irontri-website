// api/strava-exchange.js
// Vercel serverless function — handles Strava OAuth token exchange and activity updates

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, action, refresh_token, access_token, activity_id, name, description } = req.body;

  const CLIENT_ID = '216800';
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

  try {
    // ── UPDATE ACTIVITY DESCRIPTION ──────────────────────────────────────────
    if (action === 'update_activity') {
      if (!access_token || !activity_id) {
        return res.status(400).json({ error: 'Missing access_token or activity_id' });
      }
      const r = await fetch(`https://www.strava.com/api/v3/activities/${activity_id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ error: data.message || 'Strava update error' });
      return res.status(200).json({ success: true, activity_id: data.id });
    }

    // ── TOKEN REFRESH ─────────────────────────────────────────────────────────
    if (action === 'refresh') {
      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token,
      });
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ error: data.message || 'Strava error' });
      return res.status(200).json(data);
    }

    // ── INITIAL CODE EXCHANGE ─────────────────────────────────────────────────
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });
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
