// api/build-remaining.js
export const config = { maxDuration: 300 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { planId, userId } = req.body;
  if (!planId || !userId) return res.status(400).json({ error: 'Missing planId or userId' });

  try {
    const planRes = await fetch(`${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}&order=created_at.desc&limit=1`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      }
    });
    const plans = await planRes.json();

    console.log('plans query result:', plans?.length, 'for userId:', userId);

    if (!plans || plans.length === 0) {
      return res.status(404).json({ error: 'Plan not found', userId });
    }

    const plan = plans.find(p => String(p.id) === String(planId)) || plans[0];
    console.log('Using plan id:', plan.id, 'requested planId:', planId);

    let txt = plan.plan_data || '';
    txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    const planData = JSON.parse(txt);

    const builtSoFar = planData.weeks?.length || 0;
    const totalNeeded = planData.totalWeeksPlanned || 0;
    const basePrompt = planData.basePrompt || '';

    console.log('builtSoFar:', builtSoFar, 'totalNeeded:', totalNeeded, 'hasPrompt:', !!basePrompt);

    if (!basePrompt) return res.status(400).json({ error: 'No basePrompt available' });
    if (builtSoFar >= totalNeeded) return res.status(200).json({ success: true, done: true, builtSoFar, totalNeeded });

    const startWk = builtSoFar + 1;
    const endWk = Math.min(builtSoFar + 2, totalNeeded);

    const isFinalBatch = endWk >= totalNeeded;
    const raceDistanceLower = (basePrompt || '').toLowerCase();
    const isSprint = raceDistanceLower.includes('sprint');
    const isOlympic = raceDistanceLower.includes('olympic');
    const isHalf = raceDistanceLower.includes('70.3') || raceDistanceLower.includes('half ironman');
    const isFull = raceDistanceLower.includes('140.6') || raceDistanceLower.includes('full ironman');

    const raceDayDistances = isFull ? '3.8km swim, 180km bike, 42.2km run' : isHalf ? '1.9km swim, 90km bike, 21.1km run' : isOlympic ? '1.5km swim, 40km bike, 10km run' : '750m swim, 20km bike, 5km run';

    const restDayRule = isSprint ? 'REST DAYS: 2 rest days per week.' : isOlympic ? 'REST DAYS: 1-2 rest days per week.' : isHalf ? 'REST DAYS: 1 rest day per week. Never 0.' : 'REST DAYS: 1 rest day per week. Never 0. Never two consecutive rest days.';

    const taperRule = isSprint ? 'SPRINT TAPER: Final 4-5 days only — reduce volume 40-60%.' : isOlympic ? 'OLYMPIC TAPER: Final 2 weeks — reduce volume by 40% then 70%.' : 'FULL/HALF IRONMAN TAPER: Final 3 weeks — reduce volume by 30%, 50%, 70% respectively. Keep intensity.';

    // Calculate actual race day name from raceDate
    const raceDayName = (() => {
      const rd = planData.raceDate;
      if (!rd) return 'Sunday';
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      return days[new Date(rd + 'T00:00:00').getDay()];
    })();

    const raceDayRule = isFinalBatch ? `RACE DAY REQUIRED: The LAST day of week ${totalNeeded} MUST be a Race Day session on ${raceDayName} (this is the actual race day): {"day":"${raceDayName}","type":"Race","name":"Race Day 🏁","duration":null,"effort":9,"zone":null,"purpose":"Your race — execute your plan and enjoy every moment.","warmup":"Light warm-up as per race briefing","mainset":"${raceDayDistances} — race pace throughout.","cooldown":"Recovery walk and celebrate your achievement","coachNote":"Trust your training. Start conservative, build through the bike, and leave it all on the run. You are ready.","paceTarget":"Race pace","heartRateZone":"Race"}. The day BEFORE ${raceDayName} must be Rest. All other days can be easy shakeout or Rest.` : '';

    // Get last built week's bike data for continuity
    const lastBuiltWeeks = planData.weeks?.slice(-2) || [];
    const lastBikeDuration = (() => {
      for (let i = lastBuiltWeeks.length - 1; i >= 0; i--) {
        const w = lastBuiltWeeks[i];
        const bikeSessions = w.days?.filter(d => d.type === 'Bike' || d.type === 'Brick') || [];
        const longest = Math.max(...bikeSessions.map(d => parseFloat(d.duration) || 0), 0);
        if (longest > 0) return Math.round(longest / 60 * 10) / 10;
      }
      return null;
    })();

    // Progressive bike volume — calculated per batch so AI always gets exact targets
    const bikeVolumeRule = (() => {
      if (isFull) {
        const pct = startWk / totalNeeded;
        let longRide, weeklyBike;
        if (pct < 0.30) {
          const p = pct / 0.30;
          longRide = Math.round((2 + p * 1.5) * 10) / 10;
          weeklyBike = Math.round((3 + p * 2) * 10) / 10;
        } else if (pct < 0.65) {
          const p = (pct - 0.30) / 0.35;
          longRide = Math.round((3.5 + p * 1.5) * 10) / 10;
          weeklyBike = Math.round((5 + p * 3) * 10) / 10;
        } else if (pct < 0.85) {
          longRide = 5.5; weeklyBike = 9;
        } else {
          const p = (pct - 0.85) / 0.15;
          longRide = Math.round((5.5 - p * 4) * 10) / 10;
          weeklyBike = Math.round((9 - p * 7) * 10) / 10;
        }
        const minRide = Math.max(1.5, longRide - 0.3);
        const maxRide = longRide + 0.3;
        const continuityNote = lastBikeDuration ? ` Previous week long ride was ${lastBikeDuration}h — continue from there, do NOT drop below it.` : '';
        return `BIKE VOLUME FOR WEEKS ${startWk}-${endWk}: Long ride must be ${longRide}h (${Math.round(longRide*30)}-${Math.round(longRide*32)}km). NEVER shorter than ${minRide}h or longer than ${maxRide}h. Total weekly bike = ${weeklyBike}h. Each week slightly more than the previous.${continuityNote} NEVER generate a short ride where a long ride is scheduled.`;
      } else if (isHalf) {
        const pct = startWk / totalNeeded;
        let longRide;
        if (pct < 0.35) longRide = Math.round((1.5 + (pct/0.35) * 1.5) * 10) / 10;
        else if (pct < 0.75) longRide = Math.round((3 + ((pct-0.35)/0.40)) * 10) / 10;
        else longRide = Math.round((4 - ((pct-0.75)/0.25) * 3) * 10) / 10;
        return `BIKE VOLUME FOR WEEKS ${startWk}-${endWk}: Long ride = ${longRide}h. Never shorter than ${Math.max(1, longRide-0.5)}h or longer than ${longRide+0.5}h.`;
      }
      return 'Match bike volume to race distance with steady progressive overload.';
    })();

    const structureInstructions = `Generate ONLY weeks ${startWk} to ${endWk} (weekNumber starting at ${startWk}). Return JSON: {"weeks":[...]} — array of ${endWk - startWk + 1} weeks only. No intro. Each week MUST use this exact structure: {"weekNumber":${startWk},"phase":"Base","focus":"string","weeklyNarrative":"string","days":[{"day":"Monday","type":"Swim","name":"string","duration":45,"effort":5,"zone":2,"purpose":"string","warmup":"string","mainset":"string","cooldown":"string","coachNote":"string","paceTarget":"string","heartRateZone":"Zone 2"}]}. The days array MUST use the field names: day, type, name, duration, effort, zone, purpose, warmup, mainset, cooldown, coachNote, paceTarget, heartRateZone. type MUST be one of: Swim, Bike, Run, Brick, Strength, Rest, Race. Never use workouts, details, intensity, discipline or any other field names. ${bikeVolumeRule} ${restDayRule} ${taperRule} ${raceDayRule}`;

    const prompt = basePrompt + structureInstructions;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      console.error('AI error:', err);
      return res.status(500).json({ error: 'AI generation failed', detail: err });
    }

    const aiData = await aiRes.json();
    const aiText = (aiData.content || []).map(c => c.text || '').join('');

    const clean = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
    const s = clean.indexOf('{'); const e = clean.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'Invalid JSON from AI' });
    const parsed = JSON.parse(clean.slice(s, e + 1));
    const newWeeks = parsed.weeks || [];

    // Post-process: correct bike volume for each new week to match expected target
    if (isFull) {
      newWeeks.forEach((wk) => {
        const weekNum = (planData.weeks?.length || 0) + newWeeks.indexOf(wk) + 1;
        const pct = weekNum / totalNeeded;
        let targetLongRideHrs;
        if (pct < 0.30) {
          targetLongRideHrs = 2 + (pct / 0.30) * 1.5;
        } else if (pct < 0.65) {
          targetLongRideHrs = 3.5 + ((pct - 0.30) / 0.35) * 1.5;
        } else if (pct < 0.85) {
          targetLongRideHrs = 5.5;
        } else {
          targetLongRideHrs = 5.5 - ((pct - 0.85) / 0.15) * 4;
        }
        targetLongRideHrs = Math.max(1, Math.round(targetLongRideHrs * 10) / 10);
        const targetMins = Math.round(targetLongRideHrs * 60);

        // Find the longest bike session and correct its duration
        const bikeSessions = (wk.days || []).filter(d => d.type === 'Bike' || d.type === 'Brick');
        if (bikeSessions.length > 0) {
          const longestBike = bikeSessions.reduce((a, b) => 
            (parseFloat(a.duration) || 0) > (parseFloat(b.duration) || 0) ? a : b
          );
          const currentMins = parseFloat(longestBike.duration) || 0;
          if (Math.abs(currentMins - targetMins) > 20) {
            longestBike.duration = targetMins;
          }
        }

        // Correct long run duration for Full Ironman
        let targetRunMins;
        if (pct < 0.30) {
          targetRunMins = Math.round((60 + (pct/0.30)*30));   // Base: 60-90 min
        } else if (pct < 0.65) {
          targetRunMins = Math.round((90 + ((pct-0.30)/0.35)*60));  // Build: 90-150 min
        } else if (pct < 0.85) {
          targetRunMins = 150;  // Peak: 2.5h
        } else {
          targetRunMins = Math.max(30, Math.round(150 - ((pct-0.85)/0.15)*120));  // Taper: reduce
        }

        const runSessions = (wk.days || []).filter(d => d.type === 'Run');
        if (runSessions.length > 0) {
          const longestRun = runSessions.reduce((a, b) =>
            (parseFloat(a.duration) || 0) > (parseFloat(b.duration) || 0) ? a : b
          );
          const currentRunMins = parseFloat(longestRun.duration) || 0;
          if (currentRunMins < targetRunMins - 20 || currentRunMins > targetRunMins + 30) {
            longestRun.duration = targetRunMins;
          }
        }
      });
    }

    const allWeeks = [...(planData.weeks || []), ...newWeeks];
    allWeeks.forEach((wk, i) => { wk.weekNumber = i + 1; });

    // Post-process: strip Race sessions and fake "Race Day" sessions from non-final weeks
    const finalWeekNum = totalNeeded;
    const raceDayNameFinal = (() => {
      const rd = planData.raceDate;
      if (!rd) return 'Sunday';
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      return days[new Date(rd + 'T00:00:00').getDay()];
    })();

    // Day names in order for duration lookup
    const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

    allWeeks.forEach((wk) => {
      if (wk.weekNumber < finalWeekNum && wk.days) {
        // Check if this week has a fake race day (type Race OR name contains "Race Day")
        const hasFakeRaceDay = wk.days.some(d => d.type === 'Race' || (d.name && d.name.includes('Race Day')));

        if (hasFakeRaceDay) {
          // This whole week is corrupted — the AI treated it as race week
          // Determine correct phase and rebuild session durations
          const pct = wk.weekNumber / finalWeekNum;
          const phase = pct < 0.30 ? 'Base' : pct < 0.65 ? 'Build' : pct < 0.85 ? 'Peak' : 'Taper';
          const targetBikeMins = isFull ? Math.round(
            pct < 0.30 ? (2 + (pct/0.30)*1.5)*60 :
            pct < 0.65 ? (3.5 + ((pct-0.30)/0.35)*1.5)*60 :
            pct < 0.85 ? 330 : Math.max(60, (5.5-((pct-0.85)/0.15)*4)*60)
          ) : isHalf ? Math.round(pct < 0.5 ? 90 + pct*60 : 150 - (pct-0.5)*120) :
            isOlympic ? 75 : isSprint ? 45 : 90;

          wk.phase = phase;
          wk.focus = phase + ' training — progressive overload continues.';
          wk.weeklyNarrative = 'Continuing structured ' + phase.toLowerCase() + ' phase training with progressive overload.';

          // Calculate target durations for this week based on phase position
          const targetRunMins = isFull ? Math.round(
            pct < 0.30 ? 60 + (pct/0.30)*30 :
            pct < 0.65 ? 90 + ((pct-0.30)/0.35)*60 :
            pct < 0.85 ? 150 :
            Math.max(20, 150 - ((pct-0.85)/0.15)*120)
          ) : isHalf ? Math.round(Math.max(30, 60 + pct*60 - pct*30)) :
            isOlympic ? 50 : isSprint ? 30 : 45;
          const targetSwimMins = isFull ? Math.round(
            pct < 0.30 ? 45 + (pct/0.30)*20 :
            pct < 0.65 ? 65 + ((pct-0.30)/0.35)*25 :
            pct < 0.85 ? 90 :
            Math.max(20, 90 - ((pct-0.85)/0.15)*60)
          ) : isHalf ? 55 : isOlympic ? 40 : isSprint ? 25 : 40;

          // Fix each day — remove race day sessions and restore reasonable durations
          wk.days = wk.days.map((d, di) => {
            if (d.type === 'Race' || (d.name && d.name.includes('Race Day'))) {
              return { ...d, type: 'Rest', name: 'Rest', duration: 0, effort: 0, zone: 1, purpose: 'Recovery day', warmup: '', mainset: 'Full rest — allow your body to recover and adapt.', cooldown: '', coachNote: 'Rest is training. Use this day for sleep, nutrition and mental recovery.', paceTarget: 'N/A', heartRateZone: 'Zone 1' };
            }
            // Fix suspiciously short sessions or unrealistically long ones
            if (d.type !== 'Rest') {
              const dur = parseFloat(d.duration) || 0;
              const defaults = { Swim: targetSwimMins, Bike: targetBikeMins, Run: targetRunMins, Brick: targetBikeMins + 30, Strength: 40 };
              const target = defaults[d.type] || 45;
              if (dur < 20 || dur > 300) {
                return { ...d, duration: target };
              }
            }
            return d;
          });
        } else {
          // Just strip any stray Race type sessions
          wk.days = wk.days.map(d => {
            if (d.type === 'Race') {
              return { ...d, type: 'Rest', name: 'Rest', duration: 0, effort: 0, purpose: 'Recovery day', warmup: '', mainset: '', cooldown: '', coachNote: 'Rest and recover.' };
            }
            return d;
          });
        }
      }

      // Fix race day to correct day in final week
      if (wk.weekNumber === finalWeekNum && wk.days) {
        const raceDay = wk.days.find(d => d.type === 'Race' || (d.name && d.name.includes('Race Day')));
        if (raceDay) {
          const currentDay = raceDay.day;
          if (currentDay !== raceDayNameFinal) {
            const wrongIdx = wk.days.indexOf(raceDay);
            const correctIdx = wk.days.findIndex(d => d.day === raceDayNameFinal);
            if (wrongIdx !== -1 && correctIdx !== -1) {
              const correctSession = wk.days[correctIdx];
              wk.days[wrongIdx] = { ...correctSession, type: 'Rest', name: 'Rest', duration: 0, effort: 0, purpose: 'Recovery day', warmup: '', mainset: '', cooldown: '', coachNote: 'Rest and recover.' };
              wk.days[correctIdx] = { ...raceDay, day: raceDayNameFinal, type: 'Race' };
            }
          } else {
            // Ensure it's type Race
            const idx = wk.days.indexOf(raceDay);
            wk.days[idx] = { ...raceDay, type: 'Race' };
          }
        }
      }
    });

    const updated = { ...planData, weeks: allWeeks };
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/plans?id=eq.${plan.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ plan_data: JSON.stringify(updated) })
    });

    console.log('PATCH status:', patchRes.status);

    const newTotal = allWeeks.length;
    return res.status(200).json({ success: true, done: newTotal >= totalNeeded, builtSoFar: newTotal, totalNeeded });

  } catch (e) {
    console.error('build-remaining error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
