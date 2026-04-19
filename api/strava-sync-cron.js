// api/strava-sync-cron.js
// Daily cron: syncs Strava activities for all connected users and auto-completes matching plan sessions
// Runs at 16:00 UTC = midnight Perth (UTC+8)
// Triggered by vercel.json cron schedule

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://aezfxagplaxlmovqbmfd.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

// Sport type mapping from Strava activity types to irontri session types
const STRAVA_TYPE_MAP = {
  Swim: 'Swim',
  Ride: 'Bike',
  VirtualRide: 'Bike',
  Run: 'Run',
  VirtualRun: 'Run',
  Walk: 'Run',
  TrailRun: 'Run',
  Workout: 'Strength',
  WeightTraining: 'Strength',
};

async function refreshStravaToken(user) {
  const now = Math.floor(Date.now() / 1000);
  if (user.strava_token_expires_at > now) {
    return user.strava_access_token;
  }

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.strava_refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed for user ${user.id}: ${res.status}`);
  }

  const tokens = await res.json();

  await supabase
    .from('users')
    .update({
      strava_access_token: tokens.access_token,
      strava_refresh_token: tokens.refresh_token,
      strava_token_expires_at: tokens.expires_at,
    })
    .eq('id', user.id);

  return tokens.access_token;
}

async function fetchRecentActivities(accessToken) {
  // Fetch activities from last 2 days to catch any missed
  const after = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
  const res = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=10`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    throw new Error(`Activities fetch failed: ${res.status}`);
  }

  return res.json();
}

function getLocalDateStr(isoTimestamp) {
  // Strava returns start_date_local which is already in athlete's local time
  return isoTimestamp.substring(0, 10); // "YYYY-MM-DD"
}

function sessionMatchesActivity(session, activityType, activityDateStr) {
  if (!session || !session.day) return false;

  const sessionType = session.type;
  const mappedType = STRAVA_TYPE_MAP[activityType];

  if (!mappedType) return false;

  // Brick sessions count for either Bike or Run
  if (sessionType === 'Brick') {
    return mappedType === 'Bike' || mappedType === 'Run';
  }

  return sessionType === mappedType;
}

async function syncUserActivities(user, accessToken) {
  let activities;
  try {
    activities = await fetchRecentActivities(accessToken);
  } catch (err) {
    console.error(`Activity fetch failed for ${user.id}:`, err.message);
    return { userId: user.id, skipped: true, reason: 'activity_fetch_failed' };
  }

  if (!activities.length) {
    return { userId: user.id, matched: 0 };
  }

  // Get user's active plan
  const { data: plans, error: planErr } = await supabase
    .from('plans')
    .select('id, plan_data')
    .eq('user_id', user.id)
    .order('id', { ascending: false })
    .limit(1);

  if (planErr || !plans?.length) {
    return { userId: user.id, skipped: true, reason: 'no_plan' };
  }

  const plan = plans[0];
  const planData = plan.plan_data;
  const weeks = planData?.weeks;

  if (!weeks?.length) {
    return { userId: user.id, skipped: true, reason: 'no_weeks' };
  }

  // Get existing completions to avoid duplicates
  const { data: existingCompletions } = await supabase
    .from('completions')
    .select('week_num, day')
    .eq('user_id', user.id)
    .eq('plan_id', plan.id);

  const completionSet = new Set(
    (existingCompletions || []).map(c => `${c.week_num}:${c.day}`)
  );

  // Build a date→session lookup from the plan
  const startDate = new Date(planData.startDate + 'T00:00:00');
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let newCompletions = 0;

  for (const activity of activities) {
    const activityDateStr = getLocalDateStr(activity.start_date_local);
    const activityDate = new Date(activityDateStr + 'T00:00:00');
    const mappedType = STRAVA_TYPE_MAP[activity.type];

    if (!mappedType) continue;

    // Find which week + day this activity falls on
    const diffMs = activityDate - startDate;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) continue;

    const weekIdx = Math.floor(diffDays / 7);
    if (weekIdx >= weeks.length) continue;

    const week = weeks[weekIdx];
    const weekNum = weekIdx + 1;
    const dayName = DAY_NAMES[activityDate.getDay()];

    // Find matching session in that week
    const matchingSession = week.days?.find(d => {
      if (d.day !== dayName) return false;
      return sessionMatchesActivity(d, activity.type, activityDateStr);
    });

    if (!matchingSession) continue;

    const completionKey = `${weekNum}:${dayName}`;
    if (completionSet.has(completionKey)) continue;

    // Insert completion
    const { error: insertErr } = await supabase.from('completions').insert({
      user_id: user.id,
      plan_id: plan.id,
      week_num: weekNum,
      day: dayName,
      rpe: null,
      source: 'strava',
    });

    if (!insertErr) {
      completionSet.add(completionKey);
      newCompletions++;
    }
  }

  return { userId: user.id, matched: newCompletions };
}

// ---------------------------------------------------------------------------
// FITNESS REFRESH
// ---------------------------------------------------------------------------

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

async function fetchFitnessActivities(accessToken) {
  const after = Math.floor(Date.now() / 1000) - 8 * 7 * 24 * 60 * 60;
  const res = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Fitness fetch failed: ${res.status}`);
  return res.json();
}

function calcPace(activities, type) {
  const filtered = activities
    .filter(a => a.type === type && a.distance > 0 && a.moving_time > 0)
    .slice(0, 10);
  if (!filtered.length) return null;
  const avgSecsPerMetre = filtered.reduce((sum, a) => sum + a.moving_time / a.distance, 0) / filtered.length;
  const secsPerKm = avgSecsPerMetre * 1000;
  const mins = Math.floor(secsPerKm / 60);
  const secs = Math.round(secsPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}/km`;
}

function calcBikeSpeed(activities) {
  const rides = activities
    .filter(a => (a.type === 'Ride' || a.type === 'VirtualRide') && a.distance > 0 && a.moving_time > 0)
    .slice(0, 10);
  if (!rides.length) return null;
  const avgMps = rides.reduce((sum, a) => sum + a.distance / a.moving_time, 0) / rides.length;
  return Math.round(avgMps * 3.6 * 10) / 10 + ' km/h';
}

function calcFTP(activities) {
  const rides = activities
    .filter(a => (a.type === 'Ride' || a.type === 'VirtualRide') && a.average_watts > 0)
    .slice(0, 10);
  if (!rides.length) return null;
  const avgWatts = rides.reduce((sum, a) => sum + a.average_watts, 0) / rides.length;
  return Math.round(avgWatts * 0.95) + 'W';
}

function calcHRZones(activities) {
  const withHR = activities.filter(a => a.average_heartrate > 0);
  if (!withHR.length) return null;
  const maxHR = Math.max(...withHR.map(a => a.max_heartrate || a.average_heartrate));
  if (!maxHR) return null;
  return {
    z1: Math.round(maxHR * 0.50) + '–' + Math.round(maxHR * 0.60) + ' bpm',
    z2: Math.round(maxHR * 0.60) + '–' + Math.round(maxHR * 0.70) + ' bpm',
    z3: Math.round(maxHR * 0.70) + '–' + Math.round(maxHR * 0.80) + ' bpm',
    z4: Math.round(maxHR * 0.80) + '–' + Math.round(maxHR * 0.90) + ' bpm',
    z5: Math.round(maxHR * 0.90) + '–' + maxHR + ' bpm',
  };
}

async function refreshUserFitness(user, accessToken) {
  const lastUpdated = user.strava_fitness_updated_at ? new Date(user.strava_fitness_updated_at) : null;
  if (lastUpdated && Date.now() - lastUpdated.getTime() < FOURTEEN_DAYS_MS) {
    return { fitnessRefreshed: false };
  }

  let activities;
  try {
    activities = await fetchFitnessActivities(accessToken);
  } catch (err) {
    return { fitnessRefreshed: false };
  }

  const fitness = {
    runPace: calcPace(activities, 'Run') || calcPace(activities, 'VirtualRun'),
    swimPace: calcPace(activities, 'Swim'),
    bikeSpeed: calcBikeSpeed(activities),
    ftp: calcFTP(activities),
    hrZones: calcHRZones(activities),
    calculatedAt: new Date().toISOString(),
  };

  await supabase
    .from('users')
    .update({
      strava_fitness: fitness,
      strava_fitness_updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  return { fitnessRefreshed: true };
}

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.headers['x-vercel-cron'] !== '1') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[strava-sync-cron] Starting daily Strava sync');

  const { data: users, error } = await supabase
    .from('users')
    .select('id, strava_access_token, strava_refresh_token, strava_token_expires_at, strava_fitness_updated_at')
    .not('strava_athlete_id', 'is', null)
    .not('strava_access_token', 'is', null);

  if (error) {
    console.error('[strava-sync-cron] Failed to fetch users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }

  console.log(`[strava-sync-cron] Processing ${users.length} Strava-connected users`);

  const results = [];

  for (const user of users) {
    try {
      // Refresh token once, reuse for both jobs
      let accessToken;
      try {
        accessToken = await refreshStravaToken(user);
      } catch (err) {
        console.error(`Token refresh failed for ${user.id}:`, err.message);
        results.push({ userId: user.id, skipped: true, reason: 'token_refresh_failed' });
        continue;
      }

      // Job 1: auto-complete sessions
      const syncResult = await syncUserActivities(user, accessToken);

      // Job 2: refresh fitness if stale
      const fitnessResult = await refreshUserFitness(user, accessToken);

      results.push({ userId: user.id, ...syncResult, ...fitnessResult });
    } catch (err) {
      console.error(`[strava-sync-cron] Unhandled error for user ${user.id}:`, err.message);
      results.push({ userId: user.id, skipped: true, reason: 'unhandled_error' });
    }
  }

  const totalMatched = results.reduce((sum, r) => sum + (r.matched || 0), 0);
  const fitnessRefreshed = results.filter(r => r.fitnessRefreshed).length;
  const skipped = results.filter(r => r.skipped).length;

  console.log(`[strava-sync-cron] Done. ${totalMatched} new completions, ${fitnessRefreshed} fitness updates, ${skipped} skipped`);

  return res.status(200).json({
    processed: users.length,
    totalMatched,
    fitnessRefreshed,
    skipped,
    results,
  });
}
