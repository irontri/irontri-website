export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN || 'irontri_strava_webhook';
const AUTO_TAG_TEXT = '\n\nTrained with irontri - irontriapp.com';

const TYPE_MAP = {
  'Run': 'Run', 'TrailRun': 'Run', 'Walk': 'Run',
  'Ride': 'Bike', 'VirtualRide': 'Bike', 'EBikeRide': 'Bike',
  'Swim': 'Swim', 'OpenWaterSwim': 'Swim'
};

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// Use service role key to bypass RLS for webhook operations
async function sbFetch(path, options) {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
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

  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
      return res.status(200).json({ 'hub.challenge': challenge });
    }
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const event = req.body;
  if (event.object_type !== 'activity' || event.aspect_type !== 'create') {
    return res.status(200).json({ ok: true });
  }

  const stravaAthleteId = event.owner_id;
  const activityId = event.object_id;

  try {
    const userRes = await sbFetch(
      '/rest/v1/users?strava_athlete_id=eq.' + stravaAthleteId +
      '&select=id,strava_access_token,strava_refresh_token,strava_token_expires_at,strava_auto_tag'
    );
    const users = await userRes.json();
    if (!users || users.length === 0) return res.status(200).json({ ok: true });

    const user = users[0];
    if (user.strava_auto_tag === false) return res.status(200).json({ ok: true });

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
      if (!refreshRes.ok) return res.status(200).json({ ok: true });
      accessToken = refreshData.access_token;
      await sbFetch('/rest/v1/users?id=eq.' + user.id, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          strava_access_token: refreshData.access_token,
          strava_refresh_token: refreshData.refresh_token,
          strava_token_expires_at: refreshData.expires_at
        })
      });
    }

    const actRes = await fetch('https://www.strava.com/api/v3/activities/' + activityId, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const activity = await actRes.json();
    if (!actRes.ok) return res.status(200).json({ ok: true });

    if (!activity.description || !activity.description.includes('irontriapp.com')) {
      await fetch('https://www.strava.com/api/v3/activities/' + activityId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({ description: (activity.description || '') + AUTO_TAG_TEXT })
      });
    }

    const sessionType = TYPE_MAP[activity.type];
    if (sessionType && activity.start_date_local) {
      const activityDate = activity.start_date_local.split('T')[0];
      const planRes = await sbFetch(
        '/rest/v1/plans?user_id=eq.' + user.id + '&select=id,plan_data&order=created_at.desc&limit=1'
      );
      const plans = await planRes.json();

      if (plans && plans.length > 0) {
        const plan = plans[0];
        let planData;
        try {
          planData = typeof plan.plan_data === 'string' ? JSON.parse(plan.plan_data) : plan.plan_data;
        } catch (e) {
          return res.status(200).json({ ok: true, tagged: true });
        }

        const startDate = new Date((planData.startDate || planData.start_date) + 'T00:00:00');
        const actDate = new Date(activityDate + 'T00:00:00');
        const daysDiff = Math.floor((actDate - startDate) / (1000 * 60 * 60 * 24));
        const weekNum = Math.floor(daysDiff / 7);
        const dayOfWeek = actDate.getDay();

        if (weekNum >= 0 && planData.weeks && planData.weeks[weekNum]) {
          const days = planData.weeks[weekNum].days || [];
          let dayIndex = -1;
          for (let i = 0; i < days.length; i++) {
            if (days[i].type === sessionType && days[i].day === DAY_NAMES[dayOfWeek]) {
              dayIndex = i;
              break;
            }
          }

          if (dayIndex !== -1) {
            const existingRes = await sbFetch(
              '/rest/v1/completions?user_id=eq.' + user.id +
              '&week_num=eq.' + weekNum +
              '&day=eq.' + dayIndex +
              '&select=id'
            );
            const existing = await existingRes.json();

            if (!existing || existing.length === 0) {
              await sbFetch('/rest/v1/completions', {
                method: 'POST',
                headers: { 'Prefer': 'return=minimal' },
                body: JSON.stringify({
                  user_id: user.id,
                  plan_id: String(plan.id),
                  week_num: weekNum,
                  day: String(dayIndex),
                  source: 'strava',
                  strava_activity_id: String(activityId)
                })
              });
            }
          }
        }
      }
    }

    return res.status(200).json({ ok: true, tagged: true });

  } catch (e) {
    console.error('Webhook error:', e);
