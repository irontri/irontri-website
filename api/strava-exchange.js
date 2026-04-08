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
  // Strava redirects here with ?code=xxx&state=xxx after user authorises
  if (req.method === 'GET') {
    const { code, state, error } = req.query;

    if (error) {
      // User denied access — redirect back
      const dest = state === 'quiz_fitness' ? '/plan.html' : '/dashboard.html';
      return res.redirect(302, dest + '?strava_error=denied');
    }

    if (!code) {
      return res.status(400).json({ error: 'Missing code' });
    }

    try {
      // Exchange code for tokens
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
        const dest = state === 'quiz_fitness' ? '/plan.html' : '/dashboard.html';
        return res.redirect(302, dest + '?strava_error=' + encodeURIComponent(data.message || 'exchange_failed'));
      }

      // Save tokens to Supabase if we have a user session
      // For quiz_fitness flow, we pass tokens as URL params so plan.html can save them
      if (state === 'quiz_fitness') {
        // Redirect back to plan.html with tokens so it can save and then load fitness data
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

      // Normal dashboard flow — redirect to dashboard
      const params = new URLSearchParams({
        strava_connected: '1',
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        athlete_id: data.athlete?.id || ''
      });
      return res.redirect(302, '/dashboard.html?' + params.toString());

    } catch (e) {
      const dest = state === 'quiz_fitness' ? '/plan.html' : '/dashboard.html';
      return res.redirect(302, dest + '?strava_error=' + encodeURIComponent(e.message));
    }
  }

  // ── POST requests ─────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, action, refresh_token, access_token, activity_id, name, description } = req.body;
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

  try {
    // ── UPDATE ACTIVITY DESCRIPTION ─────────────────────────────────────────
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

    // ── TOKEN REFRESH ───────────────────────────────────────────────────────
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

    // ── INITIAL CODE EXCHANGE ───────────────────────────────────────────────
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
