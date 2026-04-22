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

  const { planId, userId, targetWeeks, stravaFitness } = req.body;
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
    const totalNeeded = targetWeeks || planData.totalWeeksPlanned || 0;
    const basePrompt = planData.basePrompt || '';

    // Build FIFO block from planData if athlete is a FIFO worker
    let fifoBlock = '';
    if (planData.fifo) {
      const fifoRestrictions = planData.fifoRestrictions || [];
      const forbiddenTypes = [];
      if (fifoRestrictions.some(r=>r.toLowerCase().includes('swim'))) forbiddenTypes.push('Swim');
      if (fifoRestrictions.some(r=>r.toLowerCase().includes('cycl')||r.toLowerCase().includes('bike'))) forbiddenTypes.push('Bike');
      if (fifoRestrictions.some(r=>r.toLowerCase().includes('run'))) forbiddenTypes.push('Run');
      if (fifoRestrictions.some(r=>r.toLowerCase().includes('gym')||r.toLowerCase().includes('strength')||r.toLowerCase().includes('weight'))) forbiddenTypes.push('Strength');

      let rosterCycle = [];
      if (planData.fifoRoster==='1/1') rosterCycle=['work','home'];
      else if (planData.fifoRoster==='2/1') rosterCycle=['work','work','home'];
      else if (planData.fifoRoster==='2/2') rosterCycle=['work','work','home','home'];
      else rosterCycle=['work','home'];

      const currentWeek = parseInt(planData.fifoCurrentWeek)||1;
      const currentStatus = planData.fifoCurrentStatus||'work';
      let cyclePos = 0, found = 0;
      for (let ci=0;ci<rosterCycle.length;ci++) {
        if (rosterCycle[ci]===currentStatus) { found++; if(found===currentWeek){cyclePos=ci;break;} }
      }

      const weekSchedule = [];
      for (let wi=0;wi<totalNeeded;wi++) weekSchedule.push(rosterCycle[(cyclePos+wi)%rosterCycle.length]);

      const workWeeks = [], homeWeeks = [];
      weekSchedule.forEach((s,i)=>{ if(s==='work') workWeeks.push(i+1); else homeWeeks.push(i+1); });

      // Only include weeks in this batch
      const batchWorkWeeks = workWeeks.filter(wn=>wn>=startWk&&wn<=endWk);
      const batchHomeWeeks = homeWeeks.filter(wn=>wn>=startWk&&wn<=endWk);

      const maxMins = planData.fifoHours==='30min-1hr'?60:planData.fifoHours==='1-2hrs'?120:planData.fifoHours==='2-3hrs'?180:240;

      if (batchWorkWeeks.length||batchHomeWeeks.length) {
        fifoBlock = ' === FIFO RULES FOR THIS BATCH ===' +
          ' WORK WEEKS in this batch: '+(batchWorkWeeks.length?batchWorkWeeks.join(','):'none') +
          ' HOME WEEKS in this batch: '+(batchHomeWeeks.length?batchHomeWeeks.join(','):'none') +
          (batchWorkWeeks.length?' BANNED types on work weeks: '+(forbiddenTypes.length?forbiddenTypes.join(','):'none')+'. MAX duration: '+maxMins+'min. Allowed: '+['Swim','Bike','Run','Strength','Brick'].filter(t=>!forbiddenTypes.includes(t)).concat(['Rest']).join(',')+' ONLY.':'') +
          ' ===';
      }
    }

    console.log('builtSoFar:', builtSoFar, 'totalNeeded:', totalNeeded, 'hasPrompt:', !!basePrompt);

    if (builtSoFar >= totalNeeded) return res.status(200).json({ success: true, done: true, builtSoFar, totalNeeded });

    const startWk = builtSoFar + 1;
    const endWk = Math.min(builtSoFar + 2, totalNeeded);

    const isFinalBatch = endWk >= totalNeeded;
    const raceDistanceLower = (basePrompt || planData.race || '').toLowerCase();
    const isSprint = raceDistanceLower.includes('sprint');
    const isOlympic = raceDistanceLower.includes('olympic');
    const isT100 = raceDistanceLower.includes('t100') || raceDistanceLower.includes('t 100') || raceDistanceLower.includes('super sprint');
    const isHalf = raceDistanceLower.includes('70.3') || raceDistanceLower.includes('half ironman') || isT100;
    const isFull = raceDistanceLower.includes('140.6') || raceDistanceLower.includes('full ironman');

    // Detect experience level from basePrompt
    const promptLower = basePrompt.toLowerCase();
    const isBeginner = promptLower.includes('beginner') || promptLower.includes('first triathlon') || promptLower.includes('new to') || promptLower.includes('complete beginner');
    const isAdvanced = promptLower.includes('advanced') || promptLower.includes('competitive') || promptLower.includes('experienced') || promptLower.includes('personal best');
    const isIntermediate = !isBeginner && !isAdvanced;

    // Double session limits by experience level
    const maxDoublesBase = isBeginner ? 0 : isIntermediate ? 1 : 2;
    const maxDoublesBuild = isBeginner ? 1 : isIntermediate ? 2 : 3;
    const maxDoublesPeak = isBeginner ? 1 : isIntermediate ? 2 : 3;

    const raceDayDistances = isFull ? '3.8km swim, 180km bike, 42.2km run' : isHalf ? '1.9km swim, 90km bike, 21.1km run' : isOlympic ? '1.5km swim, 40km bike, 10km run' : '750m swim, 20km bike, 5km run';

    const restDayRule = isSprint ? 'REST DAYS: 2 rest days per week.' : isOlympic ? 'REST DAYS: 1-2 rest days per week.' : isHalf ? 'REST DAYS: 1 rest day per week. Never 0.' : 'REST DAYS: 1 rest day per week. Never 0. Never two consecutive rest days.';

    const totalWeeks = totalNeeded;
    const taperRule = isSprint ? `SPRINT TAPER: ONLY week ${totalWeeks - 1} (second to last) reduces volume by 40-50%. Weeks 1 to ${totalWeeks - 2} must maintain progressive volume — do NOT reduce sessions or volume before week ${totalWeeks - 1}. Race week is week ${totalWeeks}. MINIMUM 5 sessions per week until taper week. NEVER drop below 4 sessions in any non-taper week. CRITICAL SPRINT TAPER RULE: The taper week MUST contain MINIMUM 4 training sessions — NEVER generate a Sprint taper week with mostly rest days. Sprint taper = short sharp sessions (20-30 min each) with race-pace touches embedded, NOT rest days. Maximum 2 consecutive rest days at any point. NEVER place 3 or more rest days in a row.` : isOlympic ? `OLYMPIC TAPER: ONLY the final 2 weeks reduce volume (week ${totalWeeks-1} = -40%, week ${totalWeeks} = race week). All weeks before that must maintain progressive volume. TAPER WEEKS MUST STILL HAVE 4-5 SESSIONS — taper means shorter sessions, NOT fewer sessions. Never drop to 1-2 sessions in a taper week. Each taper session should be 20-40% shorter than peak but include a short race-pace effort (5-15 min) to keep the athlete sharp.` : `FULL/HALF IRONMAN TAPER: Final 3 weeks — reduce volume by 30%, 50%, 70% respectively. Keep intensity touches in every week. TAPER WEEKS MUST STILL HAVE 4-5 SESSIONS — taper means shorter sessions, NOT fewer sessions. Never drop to 1-2 sessions in a taper week — that is detraining not tapering. Each taper session should be 20-40% shorter than peak but include a short race-pace effort (5-15 min) to keep sharpness. All weeks before taper must maintain progressive volume.`;

    // Calculate actual race day name from raceDate
    const raceDayName = (() => {
      const rd = planData.raceDate;
      if (!rd) return 'Sunday';
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      return days[new Date(rd + 'T00:00:00').getDay()];
    })();

    // Calculate exact day names for penultimate and race weeks based on race date
    const raceWeekSchedule = (() => {
      const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const rd = planData.raceDate;
      const startStr = planData.startDate;
      if (!rd || !startStr) return null;
      const raceDate = new Date(rd + 'T00:00:00');
      const startDate = new Date(startStr + 'T00:00:00');
      // For each of the 7 days before race + race day, figure out which week and day name
      const result = [];
      for (let i = 7; i >= 0; i--) {
        const d = new Date(raceDate);
        d.setDate(raceDate.getDate() - i);
        const diffDays = Math.round((d - startDate) / 86400000);
        const weekNum = Math.floor(diffDays / 7) + 1;
        result.push({ daysBeforeRace: i, weekNum, dayName: dayNames[d.getDay()] });
      }
      return result;
    })();

    const bikeDurRaceWeek = isFull ? '3h 30min' : isHalf ? '2h 30min' : isOlympic ? '1h 30min' : '60min';
    const swimDurRaceWeek = isFull ? 60 : isHalf ? 45 : isOlympic ? 30 : 20;
    const runDurRaceWeek = isFull ? 60 : isHalf ? 45 : isOlympic ? 30 : 20;
    const bikeIntervalsDur = isFull ? 120 : isHalf ? 90 : isOlympic ? 60 : 45;
    const swimQualityDur = isFull ? 55 : isHalf ? 45 : isOlympic ? 30 : 20;

    const raceDayRule = isFinalBatch && raceWeekSchedule ? (() => {
      const scheduleLines = raceWeekSchedule.map(s => {
        if (s.daysBeforeRace === 0) return `Week ${s.weekNum} ${s.dayName}: RACE DAY — {"day":"${raceDayName}","type":"Race","name":"Race Day 🏁","duration":null,"effort":9,"zone":null,"purpose":"Your race — execute your plan and enjoy every moment.","warmup":"Light warm-up as per race briefing","mainset":"${raceDayDistances} — race pace throughout. Swim smooth, bike strong, run proud.","cooldown":"Recovery walk and celebrate your achievement","coachNote":"Trust your training. Start conservative, build through the bike, and leave it all on the run. You are ready.","paceTarget":"Race pace","heartRateZone":"Race"}`;
        if (s.daysBeforeRace === 1) return `Week ${s.weekNum} ${s.dayName}: THREE separate entries (same day name) — (1) Easy 20min swim recce type=Swim effort=3, (2) Easy 20min jog with strides type=Run effort=3, (3) Easy 25min bike spin type=Bike effort=3`;
        if (s.daysBeforeRace === 2) return `Week ${s.weekNum} ${s.dayName}: MANDATORY FULL REST — no session at all. type=Rest. This is non-negotiable.`;
        if (s.daysBeforeRace === 3) return `Week ${s.weekNum} ${s.dayName}: MANDATORY FULL REST — no session at all. type=Rest. This is non-negotiable.`;
        if (s.daysBeforeRace === 4) return `Week ${s.weekNum} ${s.dayName}: Quality swim ${swimQualityDur}min with race pace efforts. type=Swim effort=6`;
        if (s.daysBeforeRace === 5) return `Week ${s.weekNum} ${s.dayName}: Bike ${bikeIntervalsDur}min with race pace intervals. type=Bike effort=7`;
        if (s.daysBeforeRace === 6) return `Week ${s.weekNum} ${s.dayName}: TWO entries same day name — (1) Quality swim ${swimDurRaceWeek}min type=Swim effort=6, (2) Aerobic run ${runDurRaceWeek}min with 10min at race pace type=Run effort=6`;
        if (s.daysBeforeRace === 7) return `Week ${s.weekNum} ${s.dayName}: Long bike ${bikeDurRaceWeek} TT position aerobic. type=Bike effort=5`;
        return '';
      }).join('\n');
      return `ELITE TAPER REQUIRED for weeks ${startWk}-${endWk}. Race day is ${raceDayName} in week ${totalNeeded}. Generate ALL sessions below — do NOT omit any:\n${scheduleLines}\n\nAll other days in these weeks = Rest. NEVER generate only Rest days for an entire week.`;
    })() :
    isFinalBatch ? `RACE WEEK REQUIRED: Week ${totalNeeded} is race week. Race day is ${raceDayName}. Generate proper activation sessions working back from race day. NEVER make all days Rest.` : '';

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

    const lateBrickRule = (isFull || isHalf) ? `LATE BASE BRICK SESSIONS: In the final 2-3 weeks of Base phase, include 1 brick session per week replacing a mid-week bike session. Brick run structure: 8-10 min faster effort immediately off the bike (race pace feel — not threshold, not all-out) then settle into Zone 2 for the remainder. Scale to athlete level — Beginner: 20-30 min bike + 10 min run; Intermediate: 30-45 min bike + 15 min run; Advanced: 45-60 min bike + 20 min run. Use actual pace/watts from prompt if available. coachNote must say this is neuromuscular transition adaptation only, not fitness work. BASE PHASE EXCEPTION: this brick run faster effort is the ONLY intensity permitted in Base phase — all other Base sessions remain Zone 2 only.` : '';

    const trackRule = (() => {
      const repsByDistance = isFull || isHalf ? '4-6x1000m or 3-4x1600m at race pace, rest 90sec-2min' : isOlympic ? '4-6x800m at race pace, rest 90sec' : '6-8x400m at race pace, rest 60-90sec';
      return `TRACK SESSIONS: Include 1 track run per week in Build and Peak phases only — NEVER in Base or Taper. Replaces a standalone run session, never adds on top. Structure: 20min warm up with dynamic stretching + 4-6 fast strides at end of WU; main set: ${repsByDistance}; 15min cool down + easy stretching. Use actual run pace from prompt if available. coachNote MUST include the injury warning: "If you feel any niggle or tightness — back off immediately. Consistency is everything and injury is the worst thing that can happen. If you have another hard session this week, pay attention to how your body feels and skip if needed." NEVER place track on a day adjacent to a hard bike, brick or long run.`;
    })();

    const strengthRule = `STRENGTH SESSIONS: If strength training is requested, include 1 strength session per week in Base and Build phases ONLY. NEVER in Peak, Taper or Race Week. Strength is type Strength, effort 5/10, 30-40 min. PLACEMENT: pair strength as a double session on the same day as an easy or aerobic Swim session — athlete does the swim in the morning, strength in the afternoon. NEVER pair with a hard bike, brick, long run or track session. Use the same day name as the swim session to create a double session entry.`;
    const doubleSessionRule = (isFull || isHalf) ? `DOUBLE SESSION PROGRAMMING: Professional triathlon coaches use double session days to build volume efficiently. Scale based on experience level in the prompt: BEGINNER — no doubles in Base, max 1 per week in Build/Peak (short easy sessions only, both under 45min, coachNote must reassure them this is a big step). INTERMEDIATE — 1 double in Base, up to 2 per week in Build/Peak. ADVANCED — 2 doubles in Base, up to 3 per week in Build/Peak. Valid pairings (all morning+afternoon): Swim+EasyBike, Swim+EasyRun, Swim+Strength. NEVER pair two hard sessions. NEVER doubles in Taper or Race Week. Use the same day name to create a double session entry.` : '';

    const _baseEnd=Math.floor(totalNeeded*0.30);const _buildEnd=Math.floor(totalNeeded*0.65);const _peakEnd=Math.floor(totalNeeded*0.85);const _taperEnd=totalNeeded-1;
    const _getPhase=(wk)=>wk<=_baseEnd?'Base':wk<=_buildEnd?'Build':wk<=_peakEnd?'Peak':wk<totalNeeded?'Taper':'Race Week';
    const _phaseForBatch=_getPhase(startWk);
    const intensityRule = `INTENSITY DISTRIBUTION (80/20 polarised training — enforced every week): A minimum of 80% of weekly sessions must be Zone 1-2 (effort 1-6/10). A maximum of 20% may be Zone 4-5 (effort 7-9/10). ZERO Zone 3 moderate sessions — every session is either clearly easy OR clearly hard. In a 7-session week: maximum 1-2 hard sessions. In a 5-session week: maximum 1 hard session. Hard sessions are: track runs, threshold bike intervals, VO2max efforts, race pace brick runs. Long ride and long run are ALWAYS Zone 2 easy — never make them hard.`;

    const structureInstructions = `${intensityRule} Generate ONLY weeks ${startWk} to ${endWk} (weekNumber starting at ${startWk}). Return JSON: {"weeks":[...]} — array of ${endWk - startWk + 1} weeks only. No intro. PHASE LABELS: Base=weeks 1-${_baseEnd}, Build=weeks ${_baseEnd+1}-${_buildEnd}, Peak=weeks ${_buildEnd+1}-${_peakEnd}, Taper=weeks ${_peakEnd+1}-${_taperEnd}, Race Week=week ${totalNeeded}. Week ${startWk} should be phase "${_phaseForBatch}". Each week MUST use this exact structure: {"weekNumber":${startWk},"phase":"${_phaseForBatch}","focus":"string","weeklyNarrative":"string","days":[{"day":"Monday","type":"Swim","name":"string","duration":45,"effort":5,"zone":2,"purpose":"string","warmup":"string","mainset":"string","cooldown":"string","coachNote":"string","paceTarget":"string","heartRateZone":"Zone 2"}]}. The days array MUST use the field names: day, type, name, duration, effort, zone, purpose, warmup, mainset, cooldown, coachNote, paceTarget, heartRateZone. type MUST be one of: Swim, Bike, Run, Brick, Strength, Rest, Race. Never use workouts, details, intensity, discipline or any other field names. ${lateBrickRule} ${trackRule} ${strengthRule} ${doubleSessionRule} ${bikeVolumeRule} ${restDayRule} ${taperRule} ${raceDayRule}`;

    const prompt = basePrompt + fifoBlock + structureInstructions;

    let parsed = null;
    let newWeeks = [];
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 16000,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        if (!aiRes.ok) {
          const err = await aiRes.text();
          console.error(`AI error (attempt ${attempt}):`, err);
          if (attempt === MAX_RETRIES) return res.status(500).json({ error: 'AI generation failed', detail: err });
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }

        const aiData = await aiRes.json();
        const aiText = (aiData.content || []).map(c => c.text || '').join('');
        const tokenCount = aiData.usage?.output_tokens || 0;

        if (tokenCount < 1000) {
          console.warn(`Short response on attempt ${attempt}: ${tokenCount} tokens`);
          if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
        }

        const clean = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
        const s = clean.indexOf('{'); const e = clean.lastIndexOf('}');
        if (s === -1 || e === -1) {
          console.warn(`No JSON brackets on attempt ${attempt}`);
          if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
          return res.status(500).json({ error: 'Invalid JSON from AI' });
        }

        parsed = JSON.parse(clean.slice(s, e + 1));
        newWeeks = parsed.weeks || [];
        console.log(`build-remaining success on attempt ${attempt}, weeks: ${newWeeks.length}`);
        break;

      } catch (parseErr) {
        console.warn(`JSON parse error on attempt ${attempt}:`, parseErr.message);
        if (attempt === MAX_RETRIES) return res.status(500).json({ error: 'build-remaining JSON parse failed after retries: ' + parseErr.message });
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }


    // Post-process: correct bike and run volume for each new week (skip race week)
    newWeeks.forEach((wk) => {
      if (wk.phase === 'Race Week') return; // Never override race week volumes
      const weekNum = (planData.weeks?.length || 0) + newWeeks.indexOf(wk) + 1;
      const pct = weekNum / totalNeeded;

      // Calculate target bike duration based on race distance and plan position
      let targetBikeMins, targetRunMins, targetSwimMins;

      if (isFull) {
        // Taper: week 1 = -30% (3h50), week 2 = -55% (2h30), week 3 = -70% (1h40)
        const bikeHrs = pct < 0.30 ? 2 + (pct/0.30)*1.5 :
                        pct < 0.65 ? 3.5 + ((pct-0.30)/0.35)*1.5 :
                        pct < 0.85 ? 5.0 :
                        pct < 0.90 ? 3.5 :   // Taper week 1: -30%
                        pct < 0.95 ? 2.5 :   // Taper week 2: -50%
                        1.5;                  // Taper week 3: -70%
        targetBikeMins = Math.round(bikeHrs * 60);
        targetRunMins = pct < 0.30 ? Math.round(60 + (pct/0.30)*30) :
                        pct < 0.65 ? Math.round(90 + ((pct-0.30)/0.35)*60) :
                        pct < 0.85 ? 140 :
                        pct < 0.90 ? 90 :    // Taper week 1
                        pct < 0.95 ? 60 :    // Taper week 2
                        30;                  // Taper week 3
        targetSwimMins = pct < 0.30 ? Math.round(45 + (pct/0.30)*15) :
                         pct < 0.65 ? Math.round(60 + ((pct-0.30)/0.35)*15) :
                         pct < 0.85 ? 75 :
                         pct < 0.90 ? 55 :   // Taper week 1
                         pct < 0.95 ? 40 :   // Taper week 2
                         25;                 // Taper week 3
      } else if (isHalf) {
        const bikeHrs = pct < 0.35 ? 1.5 + (pct/0.35)*1.5 :
                        pct < 0.75 ? 3 + ((pct-0.35)/0.40) :
                        pct < 0.87 ? 2.0 :   // Taper week 1: -50%
                        1.0;                  // Taper week 2: -75%
        targetBikeMins = Math.round(bikeHrs * 60);
        targetRunMins = pct < 0.35 ? Math.round(45 + (pct/0.35)*35) :
                        pct < 0.75 ? Math.round(80 + ((pct-0.35)/0.40)*40) :
                        pct < 0.87 ? 60 :    // Taper week 1
                        30;                  // Taper week 2
        targetSwimMins = pct < 0.35 ? Math.round(40 + (pct/0.35)*15) :
                         pct < 0.75 ? Math.round(55 + ((pct-0.35)/0.40)*10) :
                         pct < 0.87 ? 35 :   // Taper week 1
                         20;                 // Taper week 2
      } else if (isOlympic) {
        targetBikeMins = Math.round(Math.min(90, 45 + pct*60));
        targetRunMins = Math.round(Math.min(70, 30 + pct*50));
        targetSwimMins = Math.round(Math.min(60, 30 + pct*40));
      } else if (isSprint) {
        targetBikeMins = Math.round(Math.min(60, 25 + pct*40));
        targetRunMins = Math.round(Math.min(40, 20 + pct*25));
        targetSwimMins = Math.round(Math.min(35, 20 + pct*20));
      } else {
        return; // Unknown distance, skip
      }

      // Apply bike correction
      const bikeSessions = (wk.days || []).filter(d => d.type === 'Bike' || d.type === 'Brick');
      if (bikeSessions.length > 0) {
        const longestBike = bikeSessions.reduce((a, b) =>
          (parseFloat(a.duration) || 0) > (parseFloat(b.duration) || 0) ? a : b
        );
        longestBike.duration = targetBikeMins;
      }

      // Apply run correction
      const runSessions = (wk.days || []).filter(d => d.type === 'Run');
      if (runSessions.length > 0) {
        const longestRun = runSessions.reduce((a, b) =>
          (parseFloat(a.duration) || 0) > (parseFloat(b.duration) || 0) ? a : b
        );
        longestRun.duration = targetRunMins;
      }

      // Apply swim correction
      const swimSessions = (wk.days || []).filter(d => d.type === 'Swim');
      if (swimSessions.length > 0) {
        const longestSwim = swimSessions.reduce((a, b) =>
          (parseFloat(a.duration) || 0) > (parseFloat(b.duration) || 0) ? a : b
        );
        longestSwim.duration = targetSwimMins;
      }
      // Enforce professional double session programming — scaled by experience level
      if ((isFull || isHalf) && wk.phase !== 'Race Week' && wk.phase !== 'Taper') {
        const phase = (wk.phase || '').toLowerCase();

        // Max doubles for this phase and experience level
        const maxDoubles = phase === 'base' ? maxDoublesBase
          : phase === 'build' ? maxDoublesBuild
          : maxDoublesPeak;

        // Helper: check if a session is already paired
        const isPaired = (session) => wk.days.some(s =>
          s !== session && s.type !== 'Rest' && s.day === session.day
        );
        const countDoubles = () => {
          const pairedDays = new Set();
          wk.days.forEach(d => { if (isPaired(d)) pairedDays.add(d.day); });
          return pairedDays.size;
        };

        const swims = (wk.days || []).filter(d => d.type === 'Swim');
        const bikeDays = (wk.days || []).filter(d => d.type === 'Bike');
        const runDays = (wk.days || []).filter(d => d.type === 'Run');

        // Step 1: Always ensure secondary swim is paired (even for beginners in Build+)
        // Beginners skip this in Base phase
        const shouldPairSwim = !(isBeginner && phase === 'base');
        if (shouldPairSwim) {
          if (swims.length >= 2) {
            swims.sort((a, b) => (parseFloat(a.duration)||0) - (parseFloat(b.duration)||0));
            const secondarySwim = swims[0];
            if (!isPaired(secondarySwim)) {
              const pairTarget = bikeDays.find(b => !isPaired(b)) || runDays.find(r => !isPaired(r));
              if (pairTarget && countDoubles() < maxDoubles) {
                secondarySwim.day = pairTarget.day;
                secondarySwim.coachNote = isBeginner
                  ? 'Morning swim before your afternoon ' + pairTarget.type.toLowerCase() + ". Keep both sessions easy — you're building the habit of training twice in a day."
                  : 'Morning swim before your afternoon ' + pairTarget.type.toLowerCase() + '. Get to the pool early — this is how pros build volume without killing themselves.';
                secondarySwim.purpose = 'Second weekly swim — morning session before afternoon ' + pairTarget.type.toLowerCase() + '.';
              }
            }
          } else if (swims.length === 1 && !isPaired(swims[0]) && countDoubles() < maxDoubles) {
            const pairTarget = bikeDays.find(b => !isPaired(b)) || runDays.find(r => !isPaired(r));
            if (pairTarget) {
              const swimDur = isBeginner ? Math.round(targetSwimMins * 0.6) : Math.round(targetSwimMins * 0.75);
              wk.days.push({
                day: pairTarget.day,
                type: 'Swim',
                name: isBeginner ? 'Short Aerobic Swim' : 'Aerobic Technique Swim',
                duration: swimDur,
                effort: 5,
                zone: 2,
                purpose: 'Second weekly swim — morning session before afternoon ' + pairTarget.type.toLowerCase() + '.',
                warmup: '300m easy — focus on long strokes.',
                mainset: `${Math.round(swimDur * 0.6)} min continuous aerobic swim at Zone 2. Focus on technique — high elbow catch, bilateral breathing.`,
                cooldown: '150m easy backstroke.',
                coachNote: isBeginner
                  ? "Short morning swim before your afternoon session. Keep it easy — you're training your body to handle two sessions in a day. This is a big step."
                  : 'Morning swim before your afternoon ' + pairTarget.type.toLowerCase() + '. Two swims per week is the minimum to improve in the water.',
                paceTarget: isFull ? '2:05-2:25/100m' : '1:55-2:15/100m',
                heartRateZone: 'Zone 2'
              });
            }
          }
        }

        // Step 2: Advanced/Intermediate — add extra swim+bike double in Build/Peak
        if (!isBeginner && (phase === 'build' || phase === 'peak') && isFull && countDoubles() < maxDoubles) {
          const unpairedBike = bikeDays.find(b => !isPaired(b) &&
            !wk.days.some(s => s.type === 'Swim' && s.day === b.day));
          if (unpairedBike) {
            const swimDur = isAdvanced ? Math.round(targetSwimMins * 0.65) : Math.round(targetSwimMins * 0.55);
            wk.days.push({
              day: unpairedBike.day,
              type: 'Swim',
              name: 'Morning Aerobic Swim',
              duration: swimDur,
              effort: 4,
              zone: 2,
              purpose: 'Early morning swim before afternoon bike — classic Ironman double session.',
              warmup: '300m easy catch-up drill.',
              mainset: `${swimDur - 10} min steady aerobic swim. Consistent stroke rate, relaxed breathing, Zone 2 effort.`,
              cooldown: '200m easy choice.',
              coachNote: isAdvanced
                ? 'Early morning session before the afternoon ride. Volume is king in this phase — get comfortable doing two sessions in a day.'
                : 'Morning swim before the afternoon bike. Keep both sessions aerobic — the goal is volume, not intensity.',
              paceTarget: isFull ? '2:10-2:25/100m' : '2:00-2:15/100m',
              heartRateZone: 'Zone 2'
            });
          }
        }
      }
    });
    const allWeeks = [...(planData.weeks || []), ...newWeeks];
    allWeeks.forEach((wk, i) => { wk.weekNumber = i + 1; });

    // Force correct phase labels on ALL weeks
    const _totalWks = totalNeeded;
    const _baseEndAll = Math.round(_totalWks * 0.30);
    const _buildEndAll = Math.round(_totalWks * 0.65);
    const _peakEndAll = Math.round(_totalWks * 0.85);
    const _taperEndAll = _totalWks - 1;
    allWeeks.forEach(wk => {
      const n = wk.weekNumber;
      if (n <= _baseEndAll) wk.phase = 'Base';
      else if (n <= _buildEndAll) wk.phase = 'Build';
      else if (n <= _peakEndAll) wk.phase = 'Peak';
      else if (n < _totalWks) wk.phase = 'Taper';
      else wk.phase = 'Race Week';
    });

    // Mandatory rest day in weeks 1 and 2 for ALL athletes and ALL race distances
    allWeeks.filter(wk => wk.weekNumber <= 2).forEach(wk => {
      if (!wk.days) return;
      const restCount = wk.days.filter(d => d.type === 'Rest').length;
      if (restCount === 0) {
        const restDay = { type: 'Rest', name: 'Recovery & Adaptation', duration: 0, effort: 0, zone: 0, purpose: 'Rest and recovery — your body adapts during rest, not during training.', warmup: '', mainset: '', cooldown: '', coachNote: 'Rest days are not lazy — they are when your body absorbs training. Eat well, hydrate, get 8+ hours sleep.', paceTarget: '', heartRateZone: '' };
        // Try Friday first, then last Strength, last Bike, last session
        const friIdx = wk.days.findIndex(d => d.day === 'Friday');
        if (friIdx !== -1 && wk.days[friIdx].type !== 'Rest') {
          wk.days[friIdx] = { ...wk.days[friIdx], ...restDay, day: 'Friday' };
        } else {
          const typeOrder = ['Strength', 'Bike', 'Run', 'Swim', 'Brick'];
          let removed = false;
          for (const t of typeOrder) {
            const indices = wk.days.map((d, i) => d.type === t ? i : -1).filter(i => i !== -1);
            if (indices.length > 0) {
              const idx = indices[indices.length - 1];
              wk.days[idx] = { ...wk.days[idx], ...restDay, day: wk.days[idx].day };
              removed = true;
              break;
            }
          }
          if (!removed && wk.days.length > 0) {
            wk.days[wk.days.length - 1] = { ...wk.days[wk.days.length - 1], ...restDay };
          }
        }
      }
    });

    // Strip Strength sessions from Peak, Taper and Race Week phases
    newWeeks.forEach(wk => {
      const phase = (wk.phase || '').toLowerCase();
      if (phase === 'peak' || phase === 'taper' || phase === 'race week') {
        if (wk.days) {
          wk.days = wk.days.map(d => {
            if (d.type === 'Strength') {
              return { ...d, type: 'Rest', name: 'Rest', duration: 0, effort: 0, purpose: 'Recovery — strength work stops in Peak and Taper to allow full adaptation.', warmup: '', mainset: '', cooldown: '', coachNote: 'Strength training stops here. Your body needs full recovery for race-specific intensity.' };
            }
            return d;
          });
        }
      }
    });

    // Post-process: pair strength sessions with a swim day (double session)
    // Professional triathlon programming: strength in afternoon after morning swim
    newWeeks.forEach(wk => {
      const phase = (wk.phase || '').toLowerCase();
      if (phase === 'peak' || phase === 'taper' || phase === 'race week') return;
      if (!wk.days) return;

      wk.days.forEach((d, i) => {
        if (d.type !== 'Strength') return;

        // Check if already paired with a swim (same day name)
        const alreadyPaired = wk.days.some((s, si) => si !== i && s.type === 'Swim' && s.day === d.day);
        if (alreadyPaired) return;

        // Find an easy swim day to pair with — prefer aerobic/shorter swims
        const swimDays = wk.days
          .map((s, si) => ({ s, si }))
          .filter(({ s, si }) => s.type === 'Swim' && si !== i);

        if (swimDays.length > 0) {
          // Pick the shortest swim (most likely the aerobic/secondary swim)
          swimDays.sort((a, b) => (parseFloat(a.s.duration) || 0) - (parseFloat(b.s.duration) || 0));
          const targetSwim = swimDays[0];

          // Move strength to same day as that swim — double session
          wk.days[i] = { ...d, day: targetSwim.s.day };
          wk.days[i].coachNote = 'Do this strength session in the afternoon after your morning swim. Keep it functional — core, glutes, hip flexors. In and out in 35 minutes.';
          wk.days[i].purpose = 'Afternoon strength session paired with morning swim. Triathlon-specific: core stability, glutes, hip flexors, single-leg work.';
        } else {
          // No swim available — fall back to a rest day
          const restIdx = wk.days.findIndex((r, ri) => ri !== i && r.type === 'Rest');
          if (restIdx !== -1) {
            const restDay = wk.days[restIdx];
            const strengthDay = wk.days[i];
            wk.days[i] = { ...restDay };
            wk.days[restIdx] = { ...strengthDay, day: restDay.day };
          }
        }
      });
    });

    // Post-process: inject open water swims in Build/Peak phases
    // Monthly in Build (every 4 weeks), fortnightly in Peak (every 2 weeks)
    // Swaps out one pool swim that week — never adds on top
    const openWaterCoachNote = "Head to the ocean if you're within reasonable distance — otherwise any open water (lake, river, reservoir) works perfectly. Practice sighting every 10 strokes, wear your wetsuit if you're racing in one, and get comfortable with the conditions you'll face on race day. If you're far from open water, this is still a great mental prep session in the pool focusing on sighting drills.";
    newWeeks.forEach(wk => {
      const phase = (wk.phase || '').toLowerCase();
      if (phase !== 'build' && phase !== 'peak') return;
      const weekNum = wk.weekNumber;
      const isOpenWaterWeek = phase === 'peak' ? (weekNum % 2 === 0) : (weekNum % 4 === 0);
      if (!isOpenWaterWeek) return;
      if (!wk.days) return;
      // Find a pool swim to swap — prefer non-longest swim
      const swimSessions = wk.days.map((d, i) => ({ d, i })).filter(x => x.d.type === 'Swim');
      if (swimSessions.length === 0) return;
      // Swap the first swim session (not the longest — keep the key long pool session)
      const target = swimSessions.length > 1 ? swimSessions[0] : swimSessions[0];
      const dur = parseFloat(target.d.duration) || 50;
      wk.days[target.i] = {
        ...target.d,
        name: 'Open Water Swim',
        purpose: 'Build open water confidence, practice sighting and get comfortable racing in natural conditions.',
        warmup: '5 min easy entry and acclimatisation — get used to the water temperature and visibility.',
        mainset: `${Math.round(dur * 0.7)} min continuous open water swim — sight every 10 strokes, hold steady Zone 2 effort. Focus on relaxed breathing and smooth technique despite the conditions.`,
        cooldown: '5 min easy to shore — reflect on what felt good.',
        coachNote: openWaterCoachNote,
        heartRateZone: 'Zone 2',
        paceTarget: 'Easy Zone 2 — no pace target for open water',
        effort: 5,
        zone: 2,
      };
    });

    // Enforce minimum sessions in Peak and Taper weeks for long-distance races
    if (isFull || isHalf) {
      newWeeks.forEach(wk => {
        const phase = (wk.phase || '').toLowerCase();
        const isPeak = phase === 'peak';
        const isTaper = phase === 'taper';
        if ((isPeak || isTaper) && wk.days) {
          const sessions = wk.days.filter(d => d.type !== 'Rest').length;
          // Peak: min 4 (Full) or 3 (Half). Taper: min 4 for both (taper = shorter, not fewer)
          const minSessions = isPeak ? (isFull ? 4 : 3) : 4;
          if (sessions < minSessions) {
            const restDays = wk.days.map((d, i) => ({ d, i })).filter(x => x.d.type === 'Rest');
            const toActivate = restDays.slice(0, minSessions - sessions);
            toActivate.forEach(({ i }) => {
              const duration = isTaper ? (isFull ? 35 : 30) : (isFull ? 50 : 40);
              wk.days[i] = {
                ...wk.days[i],
                type: 'Run',
                name: isTaper ? 'Taper Activation Run' : 'Easy Aerobic Run',
                duration,
                effort: isTaper ? 6 : 5,
                zone: 2,
                purpose: isTaper ? 'Keep neuromuscular system sharp during taper — short race-pace touch.' : 'Maintain aerobic base during Peak phase.',
                warmup: '8 min easy jog',
                mainset: isTaper ? '15 min easy Zone 2, then 2x2min at race pace with 2min easy between.' : (isFull ? '30 min easy run at Zone 2 — conversational pace.' : '20 min easy run at Zone 2.'),
                cooldown: '7 min easy jog and stretch',
                coachNote: isTaper ? 'Taper means shorter sessions, not fewer. This keeps your legs sharp without fatigue.' : 'Added to ensure adequate training load.',
                paceTarget: isTaper ? 'Easy Zone 2 with 2x2min race pace efforts' : 'Easy Zone 2',
                heartRateZone: 'Zone 2'
              };
            });
          }
        }
      });
    }

    // Enforce minimum 4 sessions in Sprint/Olympic Taper weeks
    if (isSprint || isOlympic) {
      newWeeks.forEach(wk => {
        if ((wk.phase || '').toLowerCase() === 'taper' && wk.days) {
          const sessions = wk.days.filter(d => d.type !== 'Rest').length;
          if (sessions < 4) {
            const restDays = wk.days.map((d, i) => ({ d, i })).filter(x => x.d.type === 'Rest');
            const toActivate = restDays.slice(0, 4 - sessions);
            toActivate.forEach(({ i }) => {
              wk.days[i] = {
                ...wk.days[i],
                type: 'Run',
                name: 'Sharp Activation Run',
                duration: 25,
                effort: 6,
                zone: 2,
                purpose: 'Keep neuromuscular system sharp during taper — short race-pace touch.',
                warmup: '8 min easy jog',
                mainset: '10 min easy Zone 2, then 3x1min at race pace with 1min easy between. Stay controlled.',
                cooldown: '7 min easy jog',
                coachNote: 'Taper does not mean rest — it means short and sharp. This session keeps your legs firing.',
                paceTarget: 'Easy Zone 2 with 3x1min race pace efforts',
                heartRateZone: 'Zone 2 with brief Zone 4 touches'
              };
            });
          }
        }
      });
    }

    // Post-process: fix consecutive rest days (never allow 3+ in a row)
    // Fix FIFO violations — replace banned session types on work weeks
    function fixFifoViolations(weeks) {
      if (!planData.fifo || !planData.fifoRestrictions || !planData.fifoRestrictions.length) return;
      const forbidden = [];
      if (planData.fifoRestrictions.some(r=>r.toLowerCase().includes('swim'))) forbidden.push('Swim');
      if (planData.fifoRestrictions.some(r=>r.toLowerCase().includes('cycl')||r.toLowerCase().includes('bike'))) forbidden.push('Bike');
      if (planData.fifoRestrictions.some(r=>r.toLowerCase().includes('run'))) forbidden.push('Run');
      if (planData.fifoRestrictions.some(r=>r.toLowerCase().includes('gym')||r.toLowerCase().includes('strength')||r.toLowerCase().includes('weight'))) forbidden.push('Strength');
      if (!forbidden.length) return;
      let rosterCycle = [];
      if (planData.fifoRoster==='1/1') rosterCycle=['work','home'];
      else if (planData.fifoRoster==='2/1') rosterCycle=['work','work','home'];
      else if (planData.fifoRoster==='2/2') rosterCycle=['work','work','home','home'];
      else rosterCycle=['work','home'];
      const currentWeek = parseInt(planData.fifoCurrentWeek)||1;
      const currentStatus = planData.fifoCurrentStatus||'work';
      let cyclePos = 0, found = 0;
      for (let ci=0;ci<rosterCycle.length;ci++) { if(rosterCycle[ci]===currentStatus){found++;if(found===currentWeek){cyclePos=ci;break;}} }
      const maxMins = planData.fifoHours==='30min-1hr'?60:planData.fifoHours==='1-2hrs'?120:planData.fifoHours==='2-3hrs'?180:240;
      const allTypes = ['Swim','Bike','Run','Strength','Brick'];
      const allowed = allTypes.filter(t=>!forbidden.includes(t));
      if (!allowed.length) allowed.push('Run');
      weeks.forEach((week, idx) => {
        const isWork = rosterCycle[(cyclePos+idx)%rosterCycle.length]==='work';
        if (!isWork) return;
        (week.days||[]).forEach(day => {
          if (day.type==='Rest') return;
          if (forbidden.some(f=>f.toLowerCase()===(day.type||'').toLowerCase())) {
            const replacement = allowed[0];
            day.type = replacement; day.name = replacement+' Session';
            day.purpose = 'Work week session — adjusted for on-site availability';
            day.warmup = '10 min easy warm up'; day.mainset = 'Main '+replacement.toLowerCase()+' effort';
            day.cooldown = '5 min cool down';
            day.coachNote = 'Original session converted to '+replacement+' — restricted equipment not available on site this week.';
          }
          if (day.duration > maxMins) day.duration = maxMins;
        });
      });
    }

    function fixConsecutiveRestDays(weeks) {
      const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
      weeks.forEach((wk) => {
        if (!wk.days || wk.days.length === 0) return;
        const sorted = [...wk.days].sort((a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day));
        let restRun = 0, restStart = -1;
        for (let i = 0; i <= sorted.length; i++) {
          const isRest = i < sorted.length && sorted[i].type === 'Rest';
          if (isRest) {
            if (restRun === 0) restStart = i;
            restRun++;
          } else {
            if (restRun >= 3) {
              const midIdx = restStart + Math.floor(restRun / 2);
              const midDay = sorted[midIdx];
              const raceIdx = sorted.findIndex(d => d.type === 'Race');
              // Don't insert before or on race day
              if (midIdx !== raceIdx && midIdx !== raceIdx - 1) {
                const origIdx = wk.days.findIndex(d => d.day === midDay.day);
                if (origIdx !== -1) {
                  wk.days[origIdx] = {
                    day: midDay.day, type: 'Swim', name: 'Easy Activation Swim',
                    duration: 20, effort: 3, zone: 1,
                    purpose: 'Keep the body ticking over — light movement to stay loose without adding fatigue.',
                    warmup: '5 min easy freestyle',
                    mainset: '10 min easy continuous swim at Zone 1 — focus on stroke feel and breathing only.',
                    cooldown: '5 min easy backstroke',
                    coachNote: 'This short session maintains neuromuscular activation without building fatigue. Feel relaxed and confident going into race day.',
                    paceTarget: 'Easy — 30-40 sec/100m slower than CSS',
                    heartRateZone: 'Zone 1-2'
                  };
                }
              }
            }
            restRun = 0; restStart = -1;
          }
        }
      });
    }
    // Post-process: strip Race sessions and fake "Race Day" sessions from non-final weeks
    const finalWeekNum = allWeeks.length; // Use actual count so stripping is accurate for all plan lengths
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
            isOlympic ? 75 : isSprint ? Math.round(Math.min(60, 25 + pct*40)) : 90;

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
            isOlympic ? 50 : isSprint ? Math.round(Math.min(40, 20 + pct*25)) : 45;
          const targetSwimMins = isFull ? Math.round(
            pct < 0.30 ? 45 + (pct/0.30)*20 :
            pct < 0.65 ? 65 + ((pct-0.30)/0.35)*25 :
            pct < 0.85 ? 90 :
            Math.max(20, 90 - ((pct-0.85)/0.15)*60)
          ) : isHalf ? 55 : isOlympic ? 40 : isSprint ? Math.round(Math.min(35, 20 + pct*20)) : 40;

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
              wk.days[correctIdx] = { ...raceDay, day: raceDayNameFinal, type: 'Race', duration: null };
            }
          } else {
            // Ensure it's type Race with null duration
            const idx = wk.days.indexOf(raceDay);
            wk.days[idx] = { ...raceDay, type: 'Race', duration: null };
          }
        }
      }
    });

    // Post-process: override race week with elite taper structure (final batch only)
    if (isFinalBatch && planData.raceDate && planData.startDate) {
      const actualFinalWeek = allWeeks.length; // Use actual count, not totalNeeded (may differ)
      const raceDate = new Date(planData.raceDate + 'T00:00:00');
      const startDate = new Date(planData.startDate + 'T00:00:00');
      const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

      // Build the 8 sessions (7 days before + race day)
      // Assign each session to the correct week based on its actual date
      const raceWeekSessions = [];
      for (let i = 7; i >= 0; i--) {
        const d = new Date(raceDate);
        d.setDate(raceDate.getDate() - i);
        const dayName = dayNames[d.getDay()];
        // Calculate which week number this date falls in based on plan start date
        const diffDays = Math.floor((d - startDate) / (1000 * 60 * 60 * 24));
        const weekNum = Math.min(actualFinalWeek, Math.max(1, Math.floor(diffDays / 7) + 1));
        raceWeekSessions.push({ daysBeforeRace: i, dayName, weekNum });
      }

      // Wipe all weeks that have race week sessions and rebuild from scratch
      const weeksToOverride = [...new Set(raceWeekSessions.map(s => s.weekNum))];
      weeksToOverride.forEach(wn => {
        const wk = allWeeks.find(w => parseInt(w.weekNumber) === wn);
        if (wk) { wk.days = []; wk.phase = wn === actualFinalWeek ? 'Race Week' : 'Taper'; }
      });

      // Inject each session into correct week
      raceWeekSessions.forEach(s => {
        const wk = allWeeks.find(w => parseInt(w.weekNumber) === s.weekNum);
        if (!wk) return;
        const dbr = s.daysBeforeRace;

        if (dbr === 0) {
          wk.days.push({ day: s.dayName, type: 'Race', name: 'Race Day 🏁', duration: null, effort: 9, zone: null, purpose: 'Your race — execute your plan and enjoy every moment.', warmup: 'Light warm-up as per race briefing', mainset: raceDayDistances + ' — race pace throughout. Swim smooth, bike strong, run proud.', cooldown: 'Recovery walk and celebrate your achievement', coachNote: 'Trust your training. Start conservative, build through the bike, and leave it all on the run. You are ready.', paceTarget: 'Race pace', heartRateZone: 'Race' });
        } else if (dbr === 1) {
          // Triple activation day
          wk.days.push({ day: s.dayName, type: 'Swim', name: 'Open Water Recce', duration: 20, effort: 3, zone: 1, purpose: 'Easy open water swim — sight the course, stay relaxed.', warmup: '5 min easy', mainset: '10 min easy swimming, practise sighting every 10 strokes.', cooldown: '5 min easy', coachNote: 'Keep it easy. This is about feeling the water and sighting your course, not training.' , paceTarget: 'Easy', heartRateZone: 'Zone 1' });
          wk.days.push({ day: s.dayName, type: 'Run', name: 'Race Eve Activation Jog', duration: 20, effort: 3, zone: 1, purpose: 'Short easy jog to keep legs loose with 4-6 fast strides.', warmup: '10 min easy jog', mainset: '4-6 x 20 second strides at race pace with full recovery between each. Everything else is easy.', cooldown: '5 min walk', coachNote: 'The strides keep your nervous system sharp without fatiguing your legs. Keep the rest easy.', paceTarget: 'Easy with strides', heartRateZone: 'Zone 1' });
          wk.days.push({ day: s.dayName, type: 'Bike', name: 'Race Eve Bike Spin', duration: 25, effort: 3, zone: 1, purpose: 'Easy spin to keep legs loose and check your bike is race ready.', warmup: '5 min easy', mainset: '15 min very easy spin. Include 3-4 x 15 second race cadence efforts.', cooldown: '5 min easy', coachNote: 'Spin easy. Check your bike over — tyres, gears, brakes. Arrive tomorrow feeling fresh.', paceTarget: 'Easy spin', heartRateZone: 'Zone 1' });
        } else if (dbr === 2) {
          wk.days.push({ day: s.dayName, type: 'Rest', name: 'Rest', duration: 0, effort: 0, zone: 1, purpose: 'Full rest day — sleep, eat well, hydrate.', warmup: '', mainset: 'Rest and recover.', cooldown: '', coachNote: 'Rest is training. Sleep as much as possible. Eat well, hydrate well. Your fitness is locked in.' });
        } else if (dbr === 3) {
          wk.days.push({ day: s.dayName, type: 'Rest', name: 'Rest', duration: 0, effort: 0, zone: 1, purpose: 'Full rest day — sleep, eat well, hydrate.', warmup: '', mainset: 'Rest and recover.', cooldown: '', coachNote: 'Another full rest day. Your body is absorbing everything. Trust the process — you are ready.' });
        } else if (dbr === 4) {
          const dur = isFull ? 55 : isHalf ? 45 : isOlympic ? 30 : 20;
          wk.days.push({ day: s.dayName, type: 'Swim', name: 'Quality Pre-Race Swim', duration: dur, effort: 6, zone: 2, purpose: 'Final quality swim — feel smooth and confident in the water.', warmup: '400m easy freestyle', mainset: `${Math.round(dur*0.6)} min swimming with some race pace efforts. Focus on technique and feel.`, cooldown: '200m easy', coachNote: 'Feel the water one last time before race day. Stay relaxed and smooth.', paceTarget: 'Race pace efforts', heartRateZone: 'Zone 2-3' });
        } else if (dbr === 5) {
          const dur = isFull ? 120 : isHalf ? 90 : isOlympic ? 60 : 45;
          wk.days.push({ day: s.dayName, type: 'Bike', name: 'Race Pace Intervals', duration: dur, effort: 7, zone: 3, purpose: 'Last intensity session — feel sharp and confident on the bike.', warmup: '20 min easy spin', mainset: isFull ? '4x10min at race pace (around 225w), 5min easy between each.' : isHalf ? '4x10min at 70.3 race pace, 5min easy between each.' : '3x8min at Olympic race pace, 5min easy between each.', cooldown: '20 min easy spin', coachNote: 'Last real intensity session. Trust your fitness.', paceTarget: 'Race pace', heartRateZone: 'Zone 3-4' });
        } else if (dbr === 6) {
          const swimDur = isFull ? 60 : isHalf ? 45 : isOlympic ? 30 : 20;
          const runDur = isFull ? 60 : isHalf ? 45 : isOlympic ? 30 : 20;
          wk.days.push({ day: s.dayName, type: 'Swim', name: 'Pre-Race Quality Swim', duration: swimDur, effort: 6, zone: 2, purpose: 'Quality swim to stay sharp in the water.', warmup: '400m easy', mainset: `${Math.round(swimDur*0.7)} min quality swimming — some race pace efforts, focus on technique.`, cooldown: '200m easy', coachNote: 'Morning session — do this first, run later in the day.', paceTarget: 'Race pace efforts', heartRateZone: 'Zone 2' });
          wk.days.push({ day: s.dayName, type: 'Run', name: 'Aerobic Run with Race Pace Push', duration: runDur, effort: 6, zone: 2, purpose: 'Aerobic run with a 10 minute push at race pace to stay sharp.', warmup: '15 min easy jog', mainset: `Easy Zone 2 running. Include 10 min at race pace in the middle — feel what race day should feel like.`, cooldown: '10 min easy jog', coachNote: 'Push to race pace for 10 minutes — feel what it should feel like on the day. Everything else is easy.', paceTarget: 'Race pace for 10min', heartRateZone: 'Zone 2' });
        } else if (dbr === 7) {
          // Only add if this day name is different from race day — avoids collision when race is on Sunday
          const raceDayNameCheck = dayNames[raceDate.getDay()];
          if (s.dayName !== raceDayNameCheck) {
            const dur = isFull ? 150 : isHalf ? 105 : isOlympic ? 75 : 50;
            wk.days.push({ day: s.dayName, type: 'Bike', name: 'Long TT Position Ride', duration: dur, effort: 5, zone: 2, purpose: 'Last long ride in race position — build confidence and feel.', warmup: '20 min easy spin', mainset: `${dur - 30} min steady aerobic riding in TT/race position on flat course. Race cadence (85-90rpm). Aerobic effort only.`, cooldown: '10 min easy spin', coachNote: 'Last big ride. Stay in your race position, feel the bike beneath you. Confidence building, not fitness building.', paceTarget: 'Aerobic Zone 2', heartRateZone: 'Zone 2' });
          }
        }
      });
    }

    // Fix duration/mainset mismatches — ensure session duration reflects actual content
    newWeeks.forEach(wk => {
      if (!wk.days) return;
      wk.days.forEach(d => {
        if (!d.duration || d.type === 'Rest' || d.type === 'Race') return;
        // If mainset mentions a duration longer than session duration, cap it
        if (d.mainset) {
          const mainsetMins = d.mainset.match(/(\d+)\s*min/i);
          if (mainsetMins) {
            const mainMins = parseInt(mainsetMins[1]);
            // Session duration should be mainset + warmup + cooldown (roughly 20-30 min extra)
            // If mainset alone is longer than total duration, fix the total duration
            if (mainMins > parseFloat(d.duration)) {
              d.duration = mainMins + 20; // add warmup/cooldown buffer
            }
          }
        }
      });
    });

    // Fix long run volume — ensure adequate standalone run sessions
    if ((isFull || isHalf) && !isBeginner) {
      newWeeks.forEach(wk => {
        const phase = (wk.phase || '').toLowerCase();
        if (phase === 'race week' || phase === 'taper') return;
        if (!wk.days) return;

        // Find standalone run sessions (not brick)
        const runSessions = wk.days.filter(d => d.type === 'Run');
        if (runSessions.length === 0) return;

        // Find the longest run
        const longestRun = runSessions.reduce((a, b) =>
          (parseFloat(a.duration)||0) > (parseFloat(b.duration)||0) ? a : b
        );

        // Minimum long run durations by phase and distance
        const minRunMins = isFull
          ? (phase === 'base' ? 50 : phase === 'build' ? 75 : 90)
          : (phase === 'base' ? 40 : phase === 'build' ? 60 : 75);

        if ((parseFloat(longestRun.duration)||0) < minRunMins) {
          longestRun.duration = minRunMins;
          longestRun.name = longestRun.name || 'Long Aerobic Run';
          if (longestRun.mainset && !longestRun.mainset.includes(minRunMins + ' min')) {
            longestRun.coachNote = (longestRun.coachNote || '') + ' This is your weekly long run — the cornerstone of run fitness. Build endurance and mental toughness at Zone 2 effort.';
          }
        }
      });
    }

    // Now safe to fix consecutive rest days — fake race days already cleaned up
    fixFifoViolations(newWeeks);
    fixConsecutiveRestDays(allWeeks);

    // Fix taper weeks with too few sessions - add easy sessions spread across the rotated week
    const ALL_WEEK_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    allWeeks.forEach(wk => {
      if (!wk.days || wk.phase !== 'Taper') return;
      const trainingSessions = wk.days.filter(d => d.type !== 'Rest');
      if (trainingSessions.length >= 3) return; // enough sessions already

      const usedDays = new Set(wk.days.filter(d => d.type !== 'Rest').map(d => d.day));

      // Rotate week from plan start day so we add sessions at the visual start of the week
      const planStartDow = planData.startDate ? new Date(planData.startDate + 'T00:00:00').getDay() : 1;
      const planStartIdx = planStartDow === 0 ? 6 : planStartDow - 1;
      const ROTATED_DAYS = [...ALL_WEEK_DAYS.slice(planStartIdx), ...ALL_WEEK_DAYS.slice(0, planStartIdx)];

      // Find where sessions sit in the rotated week
      const sessionRotPos = trainingSessions.map(d => ROTATED_DAYS.indexOf(d.day)).filter(i => i !== -1);
      const firstRotPos = sessionRotPos.length > 0 ? Math.min(...sessionRotPos) : 6;

      // Add sessions on empty days at visual start of week (before first existing session)
      const sessionsNeeded = 3 - trainingSessions.length;
      let added = 0;
      for (let i = 0; i < firstRotPos && added < sessionsNeeded; i++) {
        const day = ROTATED_DAYS[i];
        if (!usedDays.has(day)) {
          wk.days.push({
            day: day, type: 'Run', name: 'Easy Taper Run',
            duration: 20, effort: 4, zone: 2,
            purpose: 'Short easy run to stay loose and maintain feel without adding fatigue.',
            warmup: '5min easy walk/jog',
            mainset: '10min easy Zone 2 run - conversational pace, focus on cadence and form.',
            cooldown: '5min easy walk',
            coachNote: 'Keep this very easy. The goal is to stay loose and activated, not to train.',
            paceTarget: 'Zone 2 easy',
            heartRateZone: 'Zone 2'
          });
          usedDays.add(day);
          added++;
          console.log('Taper fix: added easy run on ' + day + ' week ' + wk.weekNumber);
        }
      }
    });

    const updated = { ...planData, weeks: allWeeks };
    // Preserve stravaFitness from request or existing planData
    if (stravaFitness && !updated.stravaFitness) {
      updated.stravaFitness = JSON.stringify(stravaFitness);
    }
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
