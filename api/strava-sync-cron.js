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
  const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Fitness fetch failed: ${res.status}`);
  return res.json();
}

function calcPace(activities, type) {
  const filtered = activities.filter(a => a.type === type && a.distance > 0 && a.moving_time > 0).slice(0, 10);
  if (!filtered.length) return null;
  const secsPerKm = (filtered.reduce((sum, a) => sum + a.moving_time / a.distance, 0) / filtered.length) * 1000;
  return `${Math.floor(secsPerKm / 60)}:${Math.round(secsPerKm % 60).toString().padStart(2, '0')}/km`;
}

function calcBikeSpeed(activities) {
  const rides = activities.filter(a => (a.type === 'Ride' || a.type === 'VirtualRide') && a.distance > 0 && a.moving_time > 0).slice(0, 10);
  if (!rides.length) return null;
  return Math.round((rides.reduce((sum, a) => sum + a.distance / a.moving_time, 0) / rides.length) * 3.6 * 10) / 10 + ' km/h';
}

function calcFTP(activities) {
  const rides = activities.filter(a => (a.type === 'Ride' || a.type === 'VirtualRide') && a.average_watts > 0).slice(0, 10);
  if (!rides.length) return null;
  return Math.round((rides.reduce((sum, a) => sum + a.average_watts, 0) / rides.length) * 0.95) + 'W';
}

function calcHRZones(activities) {
  const withHR = activities.filter(a => a.average_heartrate > 0);
  if (!withHR.length) return null;
  const maxHR = Math.max(...withHR.map(a => a.max_heartrate || a.average_heartrate));
  if (!maxHR) return null;
  return { z1: Math.round(maxHR*0.50)+'–'+Math.round(maxHR*0.60)+' bpm', z2: Math.round(maxHR*0.60)+'–'+Math.round(maxHR*0.70)+' bpm', z3: Math.round(maxHR*0.70)+'–'+Math.round(maxHR*0.80)+' bpm', z4: Math.round(maxHR*0.80)+'–'+Math.round(maxHR*0.90)+' bpm', z5: Math.round(maxHR*0.90)+'–'+maxHR+' bpm' };
}

async function refreshUserFitness(user, accessToken) {
  const lastUpdated = user.strava_fitness_updated_at ? new Date(user.strava_fitness_updated_at) : null;
  if (lastUpdated && Date.now() - lastUpdated.getTime() < FOURTEEN_DAYS_MS) return { fitnessRefreshed: false };
  let activities;
  try { activities = await fetchFitnessActivities(accessToken); } catch (err) { return { fitnessRefreshed: false }; }
  const fitness = { runPace: calcPace(activities, 'Run') || calcPace(activities, 'VirtualRun'), swimPace: calcPace(activities, 'Swim'), bikeSpeed: calcBikeSpeed(activities), ftp: calcFTP(activities), hrZones: calcHRZones(activities), calculatedAt: new Date().toISOString() };
  await supabase.from('users').update({ strava_fitness: fitness, strava_fitness_updated_at: new Date().toISOString() }).eq('id', user.id);
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
