// api/strava-exchange.js
// Vercel serverless function — handles Strava OAuth token exchange and activity updates

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLIENT_ID = '216800';

async function saveStravaTokens(athleteId, accessToken, refreshToken, expiresAt) {
  // Save tokens server-side using service key — bypasses RLS
  const r = await fetch(`${SUPABASE_URL}/rest/v1/users?strava_athlete_id=eq.${athleteId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      strava_access_token: accessToken,
      strava_refresh_token: refreshToken,
      strava_token_expires_at: parseInt(expiresAt),
      strava_athlete_id: String(athleteId),
      strava_token_invalid: false,
    }),
  });
  return r.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: Strava OAuth callback ────────────────────────────────────────────
  if (req.method === 'GET') {
    const { code, state, error } = req.query;
    const isApp = state === 'app';

    if (error) {
      if (isApp) return res.redirect(302, 'irontri://strava-error?error=denied');
      const dest = (state && state.startsWith('quiz_fitness')) ? '/plan.html' : '/dashboard.html';
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
        const dest = (state && state.startsWith('quiz_fitness')) ? '/plan.html' : '/dashboard.html';
        return res.redirect(302, dest + '?strava_error=' + encodeURIComponent(data.message || 'exchange_failed'));
      }

      const athleteId = data.athlete?.id || '';
      const accessToken = data.access_token;
      const refreshToken = data.refresh_token;
      const expiresAt = data.expires_at;

      // App flow — redirect to app with tokens (app saves them)
      if (isApp) {
        const params = new URLSearchParams({ access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt, athlete_id: athleteId });
        return res.redirect(302, 'irontri://strava-connected?' + params.toString());
      }

      // Quiz fitness flow — save tokens server-side then redirect back
      if (state && state.startsWith('quiz_fitness')) {
        // Extract user ID from state param (format: quiz_fitness__USER_ID)
        const userId = state.includes('__') ? state.split('__')[1] : null;
        if (userId) {
          // Save by user ID — most reliable
          await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({
              strava_access_token: accessToken,
              strava_refresh_token: refreshToken,
              strava_token_expires_at: parseInt(expiresAt),
              strava_athlete_id: String(athleteId),
              strava_token_invalid: false,
            }),
          });
        } else if (athleteId) {
          await saveStravaTokens(athleteId, accessToken, refreshToken, expiresAt);
        }
        // Also pass tokens in URL as fallback in case user row doesn't exist yet
        const params = new URLSearchParams({
          strava_connected: '1',
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expiresAt,
          athlete_id: String(athleteId),
          user_id: userId || '',
          quiz_step: '7'
        });
        return res.redirect(302, '/plan.html?' + params.toString());
      }

      // Normal dashboard flow — save tokens server-side then redirect
      if (athleteId) {
        await saveStravaTokens(athleteId, accessToken, refreshToken, expiresAt);
      }
      const params = new URLSearchParams({
        strava_connected: '1',
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        athlete_id: String(athleteId),
      });
      return res.redirect(302, '/dashboard.html?' + params.toString());

    } catch (e) {
      if (isApp) return res.redirect(302, 'irontri://strava-error?error=' + encodeURIComponent(e.message));
      const dest = (state && state.startsWith('quiz_fitness')) ? '/plan.html' : '/dashboard.html';
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
