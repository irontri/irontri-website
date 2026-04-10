export const config = { maxDuration: 10 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path, options) {
  const key = SUPABASE_SERVICE_KEY;
  return fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(options && options.headers)
    }
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id, refresh_token } = req.body;
  if (!user_id || !refresh_token) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const refreshRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token
      })
    });

    const data = await refreshRes.json();
    if (!refreshRes.ok || !data.access_token) {
      return res.status(400).json({ error: 'Failed to refresh token' });
    }

    // Update token in Supabase
    await sbFetch('/rest/v1/users?id=eq.' + user_id, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        strava_access_token: data.access_token,
        strava_refresh_token: data.refresh_token,
        strava_token_expires_at: data.expires_at
      })
    });

    return res.status(200).json({ access_token: data.access_token });
  } catch (e) {
    console.error('Token refresh error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
