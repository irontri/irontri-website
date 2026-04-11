// api/strava-exchange.js
// Vercel serverless function — handles Strava OAuth token exchange and activity updates

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CLIENT_ID = '216800';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: Strava OAuth callback ────────────────────────────────────────────
  if (req.method === 'GET') {
    const { code, state, error, app } = req.query;
    const isApp = app === 'true';

    if (error) {
      if (isApp) return res.redirect(302, 'irontri://strava-error?error=denied');
      const dest = state === 'quiz_fitness' ? '/plan.html' : '/dashboard.html';
      return res.redirect(302, dest + '?strava_error=denied');
    }

    if (!code) return res.status(400).json({ error: 'Missing code' });

    try {
      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      });
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await r.json();
      if (!r.ok) {
        if (isApp) return res.redirect(302, 'irontri://strava-error?error=' + encodeURIComponent(data.message || 'exchange_failed'));
        const dest = state === 'quiz_fitness' ? '/plan.html' : '/dashboard.html';
        return res.redirect(302, dest + '?strava_error=' + encodeURIComponent(data.message || 'exchange_failed'));
      }

      // App flow — save tokens to Supabase server-side then redirect to app
      if (isApp) {
        // We need the user's ID — get it from Supabase auth using the session
        // Since we can't get the session server-side easily, redirect to app with tokens
        // The app will save them
        const params = new URLSearchParams({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: data.expires_at,
          athlete_id: data.athlete?.id || '',
        });
        return res.redirect(302, 'irontri://strava-connected?' + params.toString());
      }

      // Quiz fitness flow
      if (state === 'quiz_fitness') {
        const params = new URLSearchParams({
          strava_connected: '1',
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: data.expires_at,
          athlete_id: data.athlete?.id || '',
          quiz_step: '7'
        });
        return res.redirect(302, '/plan.html?' + params.toString());
      }

      // Normal dashboard flow
      const params = new URLSearchParams({
        strava_connected: '1',
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        athlete_id: data.athlete?.id || ''
      });
      return res.redirect(302, '/dashboard.html?' + params.toString());

    } catch (e) {
      if (isApp) return res.redirect(302, 'irontri://strava-error?error=' + encodeURIComponent(e.message));
      const dest = state === 'quiz_fitness' ? '/plan.html' : '/dashboard.html';
      return res.redirect(302, dest + '?strava_error=' + encodeURIComponent(e.message));
    }
  }

  // ── POST requests ─────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, action, refresh_token, access_token, activity_id, name, description } = req.body;
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

  try {
    if (action === 'update_activity') {
      if (!access_token || !activity_id) return res.status(400).json({ error: 'Missing access_token or activity_id' });
      const r = await fetch(`https://www.strava.com/api/v3/activities/${activity_id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ error: data.message || 'Strava update error' });
      return res.status(200).json({ success: true, activity_id: data.id });
    }

    if (action === 'refresh') {
      const body = new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token,
      });
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json({ error: data.message || 'Strava error' });
      return res.status(200).json(data);
    }

    const body = new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      code, grant_type: 'authorization_code',
    });
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data.message || 'Strava error' });
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
