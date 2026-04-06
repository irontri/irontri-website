export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN || 'irontri_strava_webhook';
const AUTO_TAG_TEXT = '\n\n🏊🚴🏃 Trained with irontri — irontriapp.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Strava webhook verification (GET request)
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
      return res.status(200).json({ 'hub.challenge': challenge });
    }
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Handle webhook event (POST request)
  if (req.method !== 'POST') return res.status(405).end();

  const event = req.body;

  // Only process new activity creation events
  if (event.object_type !== 'activity' || event.aspect_type !== 'create') {
    return res.status(200).json({ ok: true });
  }

  const stravaAthleteId = event.owner_id;
  const activityId = event.object_id;

  try {
    // Find the irontri user with this Strava athlete ID
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/users?strava_athlete_id=eq.${stravaAthleteId}&select=id,strava_access_token,strava_refresh_token,strava_token_expires_at,strava_auto_tag`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    const users = await userRes.json();
    if (!users || users.length === 0) return res.status(200).json({ ok: true });

    const user = users[0];

    // Check if auto-tag is enabled (default true)
    if (user.strava_auto_tag === false) return res.status(200).json({ ok: true, skipped: 'auto_tag_off' });

    // Get valid access token (refresh if needed)
    let accessToken = user.strava_access_token;
    if (Date.now() / 1000 > user.strava_token_expires_at - 300) {
      const refreshRes = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: user.strava_refresh_token
        })
      });
      const refreshData = await refreshRes.json();
      if (!refreshRes.ok) return res.status(200).json({ ok: true, error: 'token_refresh_failed' });
      accessToken = refreshData.access_token;
      // Update tokens in Supabase
      await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          strava_access_token: refreshData.access_token,
          strava_refresh_token: refreshData.refresh_token,
          strava_token_expires_at: refreshData.expires_at
        })
      });
    }

    // Get current activity description
    const actRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const activity = await actRes.json();
    if (!actRes.ok) return res.status(200).json({ ok: true, error: 'activity_fetch_failed' });

    // Don't double-tag
    if (activity.description && activity.description.includes('irontriapp.com')) {
      return res.status(200).json({ ok: true, skipped: 'already_tagged' });
    }

    const newDescription = (activity.description || '') + AUTO_TAG_TEXT;

    // Update the activity description
    await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ description: newDescription })
    });

    return res.status(200).json({ ok: true, tagged: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(200).json({ ok: true }); // Always 200 to Strava
  }
}
