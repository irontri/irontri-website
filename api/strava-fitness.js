export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    // Get user Strava tokens
    const userRes = await fetch(
      SUPABASE_URL + '/rest/v1/users?id=eq.' + userId +
      '&select=id,strava_access_token,strava_refresh_token,strava_token_expires_at,strava_athlete_id',
      { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY } }
    );
    const users = await userRes.json();
    if (!users || users.length === 0 || !users[0].strava_athlete_id) {
      return res.status(200).json({ connected: false });
    }

    const user = users[0];
    let accessToken = user.strava_access_token;

    // Refresh token if needed
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
      if (!refreshRes.ok) return res.status(200).json({ connected: false });
      accessToken = refreshData.access_token;
      await fetch(SUPABASE_URL + '/rest/v1/users?id=eq.' + userId, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          strava_access_token: refreshData.access_token,
          strava_refresh_token: refreshData.refresh_token,
          strava_token_expires_at: refreshData.expires_at
        })
      });
    }

    // Fetch last 8 weeks of activities
    const after = Math.floor(Date.now() / 1000) - (56 * 24 * 60 * 60);
    const activitiesRes = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?after=' + after + '&per_page=200',
      { headers: { 'Authorization': 'Bearer ' + accessToken } }
    );
    const activities = await activitiesRes.json();

    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(200).json({ connected: true, hasData: false });
    }

    // Helpers
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const max = arr => arr.length ? Math.max(...arr) : null;
    const fmtPace = secs => {
      if (!secs) return null;
      return Math.floor(secs / 60) + ':' + String(Math.round(secs % 60)).padStart(2, '0');
    };

    // Separate by sport
    const runs  = activities.filter(a => ['Run','TrailRun','VirtualRun'].includes(a.type));
    const rides = activities.filter(a => ['Ride','VirtualRide','EBikeRide'].includes(a.type));
    const swims = activities.filter(a => ['Swim','OpenWaterSwim'].includes(a.type));

    // ── RUN DATA ──────────────────────────────────────────────────────────────
    let runData = null;
    if (runs.length >= 2) {
      const validRuns = runs.filter(r => r.distance > 1000 && r.moving_time > 0);
      const runPaces = validRuns.map(r => r.moving_time / (r.distance / 1000));
      const runHRs = runs.filter(r => r.average_heartrate).map(r => r.average_heartrate);
      const maxRunHRs = runs.filter(r => r.max_heartrate).map(r => r.max_heartrate);

      // Best effort pace from runs over 4km (proxy for threshold)
      const longerRuns = validRuns.filter(r => r.distance >= 4000);
      const bestPaceSecs = longerRuns.length > 0
        ? Math.min(...longerRuns.map(r => r.moving_time / (r.distance / 1000)))
        : null;

      // Threshold pace estimate = best pace * 1.05 (slightly slower than best)
      const thresholdPaceSecs = bestPaceSecs ? bestPaceSecs * 1.05 : null;

      const avgPaceSecs = avg(runPaces);
      const maxHR = max(maxRunHRs);
      const avgHR = avg(runHRs);

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
        avgHR: avgHR ? Math.round(avgHR) : null,
        maxHR: maxHR ? Math.round(maxHR) : null,
        weeklyDistanceKm: parseFloat((runs.reduce((a, r) => a + r.distance / 1000, 0) / 8).toFixed(1))
      };
    }

    // ── BIKE DATA ──────────────────────────────────────────────────────────────
    let bikeData = null;
    if (rides.length >= 2) {
      const validRides = rides.filter(r => r.distance > 5000 && r.moving_time > 0);
      const rideSpeeds = validRides.map(r => (r.distance / 1000) / (r.moving_time / 3600));
      const ridePowers = rides.filter(r => r.average_watts && r.average_watts > 50).map(r => r.average_watts);
      const rideMaxPowers = rides.filter(r => r.max_watts && r.max_watts > 50).map(r => r.max_watts);
      const rideHRs = rides.filter(r => r.average_heartrate).map(r => r.average_heartrate);
      const maxRideHRs = rides.filter(r => r.max_heartrate).map(r => r.max_heartrate);

      // FTP estimate: best 20min power effort * 0.95
      // If no power data, estimate from HR
      const avgPower = avg(ridePowers);
      const ftpEstimate = avgPower ? Math.round(avgPower * 0.95) : null;

      // Best speed from longer rides
      const longerRides = validRides.filter(r => r.distance >= 20000);
      const bestSpeed = longerRides.length > 0 ? max(longerRides.map(r => (r.distance / 1000) / (r.moving_time / 3600))) : null;

      const maxHR = max(maxRideHRs);
      const avgHR = avg(rideHRs);

      bikeData = {
        count: rides.length,
        totalDistanceKm: parseFloat(rides.reduce((a, r) => a + r.distance / 1000, 0).toFixed(1)),
        avgSpeedKmh: rideSpeeds.length ? parseFloat(avg(rideSpeeds).toFixed(1)) : null,
        bestSpeedKmh: bestSpeed ? parseFloat(bestSpeed.toFixed(1)) : null,
        avgWatts: avgPower ? Math.round(avgPower) : null,
        ftpEstimate: ftpEstimate,
        hasPowerMeter: ridePowers.length > 0,
        avgHR: avgHR ? Math.round(avgHR) : null,
        maxHR: maxHR ? Math.round(maxHR) : null,
        weeklyDistanceKm: parseFloat((rides.reduce((a, r) => a + r.distance / 1000, 0) / 8).toFixed(1))
      };
    }

    // ── SWIM DATA ──────────────────────────────────────────────────────────────
    let swimData = null;
    if (swims.length >= 1) {
      const validSwims = swims.filter(s => s.distance > 200 && s.moving_time > 0);
      const swimPaces = validSwims.map(s => (s.moving_time / (s.distance / 100)));
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

    // ── HEART RATE ZONES ──────────────────────────────────────────────────────
    // Use max HR from all sports to derive 5 zones
    const allMaxHRs = [
      ...runs.filter(r => r.max_heartrate).map(r => r.max_heartrate),
      ...rides.filter(r => r.max_heartrate).map(r => r.max_heartrate),
      ...swims.filter(r => r.max_heartrate).map(r => r.max_heartrate)
    ];
    const overallMaxHR = allMaxHRs.length > 0 ? Math.round(max(allMaxHRs)) : null;

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

    // ── WEEKLY VOLUME ──────────────────────────────────────────────────────────
    const totalWeeklyHours = parseFloat((
      (runData?.weeklyDistanceKm || 0) / 10 +
      (bikeData?.weeklyDistanceKm || 0) / 25 +
      (swimData?.weeklyDistanceKm || 0) / 2
    ).toFixed(1));

    const fitness = {
      connected: true,
      hasData: true,
      activitiesAnalysed: activities.length,
      weeksOfData: 8,
      run: runData,
      bike: bikeData,
      swim: swimData,
      hrZones: hrZones,
      totalWeeklyHoursEstimate: totalWeeklyHours
    };

    // Save fitness data to user record for use in plan generation
    await fetch(SUPABASE_URL + '/rest/v1/users?id=eq.' + userId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ strava_fitness: JSON.stringify(fitness) })
    });

    return res.status(200).json(fitness);

  } catch (e) {
    console.error('Strava fitness error:', e);
    return res.status(200).json({ connected: false, error: e.message });
  }
}
