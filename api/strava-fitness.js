// api/strava-sync-cron.js
// Daily cron: syncs Strava activities for all connected users and auto-completes matching plan sessions
// Runs at 16:30 UTC = 12:30am Perth (UTC+8)
// Triggered by vercel.json cron schedule

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://aezfxagplaxlmovqbmfd.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

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
  if (user.strava_token_expires_at > now) return user.strava_access_token;
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: user.strava_refresh_token }),
  });
  if (!res.ok) throw new Error(`Token refresh failed for user ${user.id}: ${res.status}`);
  const tokens = await res.json();
  await supabase.from('users').update({ strava_access_token: tokens.access_token, strava_refresh_token: tokens.refresh_token, strava_token_expires_at: tokens.expires_at }).eq('id', user.id);
  return tokens.access_token;
}

async function fetchRecentActivities(accessToken) {
  const after = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
  const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=10`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Activities fetch failed: ${res.status}`);
  return res.json();
}

function getLocalDateStr(isoTimestamp) { return isoTimestamp.substring(0, 10); }

function sessionMatchesActivity(session, activityType) {
  if (!session || !session.day) return false;
  const mappedType = STRAVA_TYPE_MAP[activityType];
  if (!mappedType) return false;
  if (session.type === 'Brick') return mappedType === 'Bike' || mappedType === 'Run';
  return session.type === mappedType;
}

async function syncUserActivities(user, accessToken) {
  let activities;
  try { activities = await fetchRecentActivities(accessToken); } catch (err) { return { userId: user.id, skipped: true, reason: 'activity_fetch_failed' }; }
  if (!activities.length) return { userId: user.id, matched: 0 };
  const { data: plans, error: planErr } = await supabase.from('plans').select('id, plan_data').eq('user_id', user.id).order('id', { ascending: false }).limit(1);
  if (planErr || !plans?.length) return { userId: user.id, skipped: true, reason: 'no_plan' };
  const plan = plans[0];
  const planData = plan.plan_data;
  const weeks = planData?.weeks;
  if (!weeks?.length) return { userId: user.id, skipped: true, reason: 'no_weeks' };
  const { data: existingCompletions } = await supabase.from('completions').select('week_num, day').eq('user_id', user.id).eq('plan_id', plan.id);
  const completionSet = new Set((existingCompletions || []).map(c => `${c.week_num}-${c.day}`));
  const startDate = new Date(planData.startDate + 'T00:00:00');
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const DAY_NAME_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  let newCompletions = 0;
  for (const activity of activities) {
    const activityDate = new Date(getLocalDateStr(activity.start_date_local) + 'T00:00:00');
    const mappedType = STRAVA_TYPE_MAP[activity.type];
    if (!mappedType) continue;
    const diffDays = Math.floor((activityDate - startDate) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) continue;
    const weekIdx = Math.floor(diffDays / 7);
    if (weekIdx >= weeks.length) continue;
    const week = weeks[weekIdx];
    const weekNum = weekIdx + 1;
    const dayName = DAY_NAMES[activityDate.getDay()];
    const slotIndex = DAY_NAME_ORDER.indexOf(dayName);
    if (slotIndex === -1) continue;
    const matchingSession = week.days?.find(d => d.day === dayName && sessionMatchesActivity(d, activity.type));
    if (!matchingSession) continue;
    const completionKey = `${weekNum}-${slotIndex}`;
    if (completionSet.has(completionKey)) continue;
    const { error: insertErr } = await supabase.from('completions').insert({ user_id: user.id, plan_id: plan.id, week_num: weekNum, day: String(slotIndex), rpe: null, source: 'strava' });
    if (!insertErr) { completionSet.add(completionKey); newCompletions++; }
  }
  return { userId: user.id, matched: newCompletions };
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

async function fetchFitnessActivities(accessToken) {
  const after = Math.floor(Date.now() / 1000) - 8 * 7 * 24 * 60 * 60;
  const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Fitness fetch failed: ${res.status}`);
  return res.json();
}

function calcRichFitness(activities) {
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const maxVal = arr => arr.length ? Math.max(...arr) : null;
  const fmtPace = secs => {
    if (!secs) return null;
    return Math.floor(secs / 60) + ':' + String(Math.round(secs % 60)).padStart(2, '0');
  };

  const runs  = activities.filter(a => ['Run','TrailRun','VirtualRun'].includes(a.type));
  const rides = activities.filter(a => ['Ride','VirtualRide'].includes(a.type));
  const swims = activities.filter(a => ['Swim','OpenWaterSwim'].includes(a.type));

  // ── RUN DATA ──
  let runData = null;
  if (runs.length >= 2) {
    const validRuns = runs.filter(r => r.distance > 1000 && r.moving_time > 0);
    const runPaces = validRuns.map(r => r.moving_time / (r.distance / 1000));
    const runHRs = runs.filter(r => r.average_heartrate).map(r => r.average_heartrate);
    const maxRunHRs = runs.filter(r => r.max_heartrate).map(r => r.max_heartrate);
    const longerRuns = validRuns.filter(r => r.distance >= 4000);
    const bestPaceSecs = longerRuns.length > 0 ? Math.min(...longerRuns.map(r => r.moving_time / (r.distance / 1000))) : null;
    const raceRuns = validRuns.filter(r => r.workout_type === 1 && r.distance >= 4000);
    const workoutRuns = validRuns.filter(r => (r.workout_type === 2 || r.workout_type === 3) && r.distance >= 4000);
    let thresholdPaceSecs = null;
    if (raceRuns.length > 0) {
      thresholdPaceSecs = Math.min(...raceRuns.map(r => r.moving_time / (r.distance / 1000)));
    } else if (workoutRuns.length > 0) {
      thresholdPaceSecs = Math.min(...workoutRuns.map(r => r.moving_time / (r.distance / 1000))) * 1.03;
    } else if (bestPaceSecs) {
      thresholdPaceSecs = bestPaceSecs * 1.10;
    }
    const avgPaceSecs = avg(runPaces);
    runData = {
      count: runs.length,
      totalDistanceKm: parseFloat(runs.reduce((a, r) => a + r.distance / 1000, 0).toFixed(1)),
      avgDistanceKm: validRuns.length ? parseFloat(avg(validRuns.map(r => r.distance / 1000)).toFixed(1)) : null,
      avgPace: fmtPace(avgPaceSecs),
      avgPaceSecs: avgPaceSecs ? Math.round(avgPaceSecs) : null,
      bestPace: fmtPace(bestPaceSecs),
      thresholdPace: fmtPace(thresholdPaceSecs),
      thresholdPaceMin: thresholdPaceSecs ? Math.floor(thresholdPaceSecs / 60) : null,
      thresholdPaceSec: thresholdPaceSecs ? Math.round(thresholdPaceSecs % 60) : null,
      avgHR: avg(runHRs) ? Math.round(avg(runHRs)) : null,
      maxHR: maxVal(maxRunHRs) ? Math.round(maxVal(maxRunHRs)) : null,
      weeklyDistanceKm: parseFloat((runs.reduce((a, r) => a + r.distance / 1000, 0) / 8).toFixed(1))
    };
  }

  // ── BIKE DATA ──
  let bikeData = null;
  if (rides.length >= 2) {
    const validRides = rides.filter(r => r.distance > 5000 && r.moving_time > 0);
    const rideSpeeds = validRides.map(r => (r.distance / 1000) / (r.moving_time / 3600));
    const rideHRs = rides.filter(r => r.average_heartrate).map(r => r.average_heartrate);
    const maxRideHRs = rides.filter(r => r.max_heartrate).map(r => r.max_heartrate);
    const longerRides = validRides.filter(r => r.distance >= 20000);
    const bestSpeed = longerRides.length > 0 ? maxVal(longerRides.map(r => (r.distance / 1000) / (r.moving_time / 3600))) : null;
    const poweredRides = rides.filter(r => r.average_watts && r.average_watts > 50 && r.moving_time > 0);
    let ftpEstimate = null, hasPowerMeter = false, avgWatts = null;
    if (poweredRides.length > 0) {
      hasPowerMeter = true;
      const allPoweredRides = rides.filter(r => r.average_watts && r.average_watts > 50);
      avgWatts = allPoweredRides.length > 0 ? Math.round(avg(allPoweredRides.map(r => r.average_watts))) : null;
      if (avgWatts) { ftpEstimate = Math.min(Math.round(avgWatts * 1.17), Math.round(avgWatts * 1.25)); }
    } else {
      const noPowerRides = validRides.filter(r => r.moving_time >= 1200 && r.moving_time <= 3600 && r.distance >= 10000);
      if (noPowerRides.length > 0) {
        const bestSpeedMs = maxVal(noPowerRides.map(r => r.distance / r.moving_time));
        ftpEstimate = Math.round((Math.round((Math.pow(bestSpeedMs, 3) * 0.24) + (bestSpeedMs * 75 * 9.81 * 0.004))) * 0.95);
      }
    }
    bikeData = {
      count: rides.length,
      totalDistanceKm: parseFloat(rides.reduce((a, r) => a + r.distance / 1000, 0).toFixed(1)),
      avgSpeedKmh: rideSpeeds.length ? parseFloat(avg(rideSpeeds).toFixed(1)) : null,
      bestSpeedKmh: bestSpeed ? parseFloat(bestSpeed.toFixed(1)) : null,
      avgWatts, ftpEstimate, hasPowerMeter,
      avgHR: avg(rideHRs) ? Math.round(avg(rideHRs)) : null,
      maxHR: maxVal(maxRideHRs) ? Math.round(maxVal(maxRideHRs)) : null,
      weeklyDistanceKm: parseFloat((rides.reduce((a, r) => a + r.distance / 1000, 0) / 8).toFixed(1))
    };
  }

  // ── SWIM DATA ──
  let swimData = null;
  if (swims.length >= 1) {
    const validSwims = swims.filter(s => s.distance > 200 && s.moving_time > 0);
    const swimPaces = validSwims.map(s => s.moving_time / (s.distance / 100));
    const avgPaceSecs = avg(swimPaces);
    const bestPaceSecs = swimPaces.length ? Math.min(...swimPaces) : null;
    swimData = {
      count: swims.length,
      totalDistanceKm: parseFloat(swims.reduce((a, s) => a + s.distance / 1000, 0).toFixed(1)),
      avgDistanceM: validSwims.length ? Math.round(avg(validSwims.map(s => s.distance))) : null,
      avgPacePer100m: fmtPace(avgPaceSecs),
      avgPaceSecs: avgPaceSecs ? Math.round(avgPaceSecs) : null,
      bestPacePer100m: fmtPace(bestPaceSecs),
      weeklyDistanceKm: parseFloat((swims.reduce((a, s) => a + s.distance / 1000, 0) / 8).toFixed(2))
    };
  }

  // ── HR ZONES ──
  const allMaxHRs = [
    ...runs.filter(r => r.max_heartrate).map(r => r.max_heartrate),
    ...rides.filter(r => r.max_heartrate).map(r => r.max_heartrate),
    ...swims.filter(r => r.max_heartrate).map(r => r.max_heartrate)
  ].sort((a, b) => a - b);
  const overallMaxHR = allMaxHRs.length > 0 ? Math.round(allMaxHRs[Math.floor(allMaxHRs.length * 0.95)]) : null;
  let hrZones = null;
  if (overallMaxHR) {
    hrZones = {
      maxHR: overallMaxHR,
      zone1: { min: Math.round(overallMaxHR * 0.50), max: Math.round(overallMaxHR * 0.60), label: 'Recovery' },
      zone2: { min: Math.round(overallMaxHR * 0.60), max: Math.round(overallMaxHR * 0.70), label: 'Aerobic Base' },
      zone3: { min: Math.round(overallMaxHR * 0.70), max: Math.round(overallMaxHR * 0.80), label: 'Tempo' },
      zone4: { min: Math.round(overallMaxHR * 0.80), max: Math.round(overallMaxHR * 0.90), label: 'Threshold' },
      zone5: { min: Math.round(overallMaxHR * 0.90), max: overallMaxHR, label: 'VO2 Max' }
    };
  }

  const totalWeeklyHours = parseFloat((
    (runData?.weeklyDistanceKm || 0) / 10 +
    (bikeData?.weeklyDistanceKm || 0) / 25 +
    (swimData?.weeklyDistanceKm || 0) / 2
  ).toFixed(1));

  return { connected: true, hasData: true, activitiesAnalysed: activities.length, weeksOfData: 8, run: runData, bike: bikeData, swim: swimData, hrZones, totalWeeklyHoursEstimate: totalWeeklyHours };
}

async function refreshUserFitness(user, accessToken) {
  const lastUpdated = user.strava_fitness_updated_at ? new Date(user.strava_fitness_updated_at) : null;
  if (lastUpdated && Date.now() - lastUpdated.getTime() < FOURTEEN_DAYS_MS) return { fitnessRefreshed: false };
  let activities;
  try { activities = await fetchFitnessActivities(accessToken); } catch (err) { return { fitnessRefreshed: false }; }
  if (!Array.isArray(activities) || activities.length === 0) return { fitnessRefreshed: false };
  const fitness = calcRichFitness(activities);
  await supabase.from('users').update({
    strava_fitness: JSON.stringify(fitness),
    strava_fitness_updated_at: new Date().toISOString()
  }).eq('id', user.id);
  return { fitnessRefreshed: true };
}

export default async function handler(req, res) {
  // Allow Vercel cron (via header or user agent) 
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['user-agent'] === 'vercel-cron/1.0';
  if (!isVercelCron) return res.status(401).json({ error: 'Unauthorized' });

  console.log('[strava-sync-cron] Starting daily Strava sync');

  const { data: users, error } = await supabase.from('users').select('id, strava_access_token, strava_refresh_token, strava_token_expires_at, strava_fitness_updated_at').not('strava_athlete_id', 'is', null).not('strava_access_token', 'is', null);
  if (error) { console.error('[strava-sync-cron] Failed to fetch users:', error); return res.status(500).json({ error: 'Failed to fetch users' }); }

  console.log(`[strava-sync-cron] Processing ${users.length} Strava-connected users`);

  const results = [];
  for (const user of users) {
    try {
      let accessToken;
      try { accessToken = await refreshStravaToken(user); } catch (err) { results.push({ userId: user.id, skipped: true, reason: 'token_refresh_failed' }); continue; }
      const syncResult = await syncUserActivities(user, accessToken);
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
  return res.status(200).json({ processed: users.length, totalMatched, fitnessRefreshed, skipped, results });
}
