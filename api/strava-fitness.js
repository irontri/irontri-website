export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
      // Use service key for token refresh write
      await fetch(SUPABASE_URL + '/rest/v1/users?id=eq.' + userId, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
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

    // Separate by sport — exclude e-bikes from ride data
    const runs  = activities.filter(a => ['Run','TrailRun','VirtualRun'].includes(a.type));
    const rides = activities.filter(a => ['Ride','VirtualRide'].includes(a.type)); // EBikeRide excluded
    const swims = activities.filter(a => ['Swim','OpenWaterSwim'].includes(a.type));

    // ── RUN DATA ──────────────────────────────────────────────────────────────
    let runData = null;
    if (runs.length >= 2) {
      const validRuns = runs.filter(r => r.distance > 1000 && r.moving_time > 0);
      const runPaces = validRuns.map(r => r.moving_time / (r.distance / 1000));
      const runHRs = runs.filter(r => r.average_heartrate).map(r => r.average_heartrate);
      const maxRunHRs = runs.filter(r => r.max_heartrate).map(r => r.max_heartrate);

      // Best effort pace from runs over 4km
      const longerRuns = validRuns.filter(r => r.distance >= 4000);
      const bestPaceSecs = longerRuns.length > 0
        ? Math.min(...longerRuns.map(r => r.moving_time / (r.distance / 1000)))
        : null;

      // Threshold pace — priority order:
      // 1. Races (workout_type=1) over 4km — race pace is a strong threshold signal
      // 2. Hard workout efforts (workout_type=2 or 3) over 4km
      // 3. Fallback: best pace * 1.10 (more conservative — avoids setting threshold from a sprint)
      const raceRuns = validRuns.filter(r => r.workout_type === 1 && r.distance >= 4000);
      const workoutRuns = validRuns.filter(r => (r.workout_type === 2 || r.workout_type === 3) && r.distance >= 4000);

      let thresholdPaceSecs = null;
      if (raceRuns.length > 0) {
        // Best race pace — races are the most reliable threshold indicator for age groupers
        const bestRacePace = Math.min(...raceRuns.map(r => r.moving_time / (r.distance / 1000)));
        thresholdPaceSecs = bestRacePace;
      } else if (workoutRuns.length > 0) {
        // Best hard workout pace — slightly slower than race pace
        const bestWorkoutPace = Math.min(...workoutRuns.map(r => r.moving_time / (r.distance / 1000)));
        thresholdPaceSecs = bestWorkoutPace * 1.03;
      } else if (bestPaceSecs) {
        // Fallback: best pace from any run with a more conservative buffer
        thresholdPaceSecs = bestPaceSecs * 1.10;
      }

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
      const rideHRs = rides.filter(r => r.average_heartrate).map(r => r.average_heartrate);
      const maxRideHRs = rides.filter(r => r.max_heartrate).map(r => r.max_heartrate);

      const maxHR = max(maxRideHRs);
      const avgHR = avg(rideHRs);

      // Best speed from longer rides
      const longerRides = validRides.filter(r => r.distance >= 20000);
      const bestSpeed = longerRides.length > 0
        ? max(longerRides.map(r => (r.distance / 1000) / (r.moving_time / 3600)))
        : null;

      // ── FTP ESTIMATION ────────────────────────────────────────────────────
      // Scenario 1: Has power meter — use best average watts from 20-60 min efforts
      const poweredRides = rides.filter(r =>
        r.average_watts && r.average_watts > 50 &&
        r.moving_time >= 1200 && r.moving_time <= 3600 // 20-60 min range
      );

      let ftpEstimate = null;
      let hasPowerMeter = false;
      let avgWatts = null;

      if (poweredRides.length > 0) {
        // Power meter path — best sustained effort in 20-60 min range * 0.95
        hasPowerMeter = true;
        const bestEffortWatts = max(poweredRides.map(r => r.average_watts));
        ftpEstimate = Math.round(bestEffortWatts * 0.95);
        // Also calculate overall avg watts for context
        const allPoweredRides = rides.filter(r => r.average_watts && r.average_watts > 50);
        avgWatts = allPoweredRides.length > 0 ? Math.round(avg(allPoweredRides.map(r => r.average_watts))) : null;
      } else {
        // Scenario 2: No power meter — estimate FTP from speed and HR
        // Method: use best average speed from 20-60 min rides as a proxy
        // Then estimate FTP using a cycling power model: P ≈ speed^3 * 0.0085 (rough approximation for flat riding)
        // This is a conservative estimate — better than nothing
        const noPoweRidesInRange = validRides.filter(r =>
          r.moving_time >= 1200 && r.moving_time <= 3600 && r.distance >= 10000
        );
        if (noPoweRidesInRange.length > 0) {
          const bestSpeedMs = max(noPoweRidesInRange.map(r => r.distance / r.moving_time)); // m/s
          // Rough power estimate: accounts for rolling resistance + aerodynamic drag at typical road cycling position
          // P(watts) ≈ (speed_ms^3 * 0.24) + (speed_ms * 75 * 9.81 * 0.004) for ~75kg rider
          const estimatedPower = Math.round((Math.pow(bestSpeedMs, 3) * 0.24) + (bestSpeedMs * 75 * 9.81 * 0.004));
          ftpEstimate = Math.round(estimatedPower * 0.95);
          hasPowerMeter = false;
        } else if (avgHR && maxHR) {
          // Fallback: HR-based estimate if no suitable rides
          // Athletes riding at ~75% max HR typically produce ~55% of max aerobic power
          // Rough FTP for average recreational cyclist: use HR ratio as proxy
          const hrRatio = avgHR / maxHR;
          // Typical recreational cyclist FTP range 150-280w, scale by HR effort
          ftpEstimate = Math.round(150 + (hrRatio * 150));
          hasPowerMeter = false;
        }
      }

      bikeData = {
        count: rides.length,
        totalDistanceKm: parseFloat(rides.reduce((a, r) => a + r.distance / 1000, 0).toFixed(1)),
        avgSpeedKmh: rideSpeeds.length ? parseFloat(avg(rideSpeeds).toFixed(1)) : null,
        bestSpeedKmh: bestSpeed ? parseFloat(bestSpeed.toFixed(1)) : null,
        avgWatts,
        ftpEstimate,
        hasPowerMeter,
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
    // Use 95th percentile of max HR across all activities to avoid outlier spikes
    const allMaxHRs = [
      ...runs.filter(r => r.max_heartrate).map(r => r.max_heartrate),
      ...rides.filter(r => r.max_heartrate).map(r => r.max_heartrate),
      ...swims.filter(r => r.max_heartrate).map(r => r.max_heartrate)
    ].sort((a, b) => a - b);

    // 95th percentile — avoids single spike from a bad reading
    const overallMaxHR = allMaxHRs.length > 0
      ? Math.round(allMaxHRs[Math.floor(allMaxHRs.length * 0.95)])
      : null;

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

    // Save fitness data to user record — use service key to avoid RLS issues
    await fetch(SUPABASE_URL + '/rest/v1/users?id=eq.' + userId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
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
