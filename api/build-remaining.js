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

    const raceDayDistances = isFull
      ? '3.8km swim, 180km bike, 42.2km run'
      : isHalf
        ? '1.9km swim, 90km bike, 21.1km run'
        : isOlympic
          ? '1.5km swim, 40km bike, 10km run'
          : '750m swim, 20km bike, 5km run';

    const restDayRule = isSprint
      ? 'REST DAYS: 2 rest days per week for sprint plans.'
      : isOlympic
        ? 'REST DAYS: 1-2 rest days per week — 1 in build/peak, 2 in taper/recovery weeks.'
        : isHalf
          ? 'REST DAYS: 1 rest day per week. Never 0.'
          : 'REST DAYS: 1 rest day per week. Never 0. Never two consecutive rest days.';

    const taperRule = isSprint
      ? 'SPRINT TAPER: Final 4-5 days only — reduce volume 40-60%. No multi-week taper. Last hard session is 3 days before race day.'
      : isOlympic
        ? 'OLYMPIC TAPER: Final 2 weeks — reduce volume by 40% then 70%. Keep intensity sharp.'
        : 'FULL/HALF IRONMAN TAPER: Final 3 weeks — reduce volume by 30%, 50%, 70% respectively. Keep intensity.';

    const raceDayRule = isFinalBatch
      ? `RACE DAY REQUIRED: Week ${totalNeeded} is the final week. The LAST day of week ${totalNeeded} MUST be a Race Day session: {"day":"Sunday","type":"Race","name":"Race Day 🏁","duration":null,"effort":9,"zone":null,"purpose":"Your race — execute your plan and enjoy every moment.","warmup":"Light warm-up as per race briefing","mainset":"${raceDayDistances} — race pace throughout. Swim smooth, bike strong, run proud.","cooldown":"Recovery walk and celebrate your achievement","coachNote":"Trust your training. Start conservative, build through the bike, and leave it all on the run. You are ready.","paceTarget":"Race pace","heartRateZone":"Race"}. The day BEFORE race day must be Rest. Never end the final week on a Rest day.`
      : '';

    const structureInstructions = `Generate ONLY weeks ${startWk} to ${endWk} (weekNumber starting at ${startWk}). Return JSON: {"weeks":[...]} — array of ${endWk - startWk + 1} weeks only. No intro. Each week MUST use this exact structure: {"weekNumber":${startWk},"phase":"Base","focus":"string","weeklyNarrative":"string","days":[{"day":"Monday","type":"Swim","name":"string","duration":45,"effort":5,"zone":2,"purpose":"string","warmup":"string","mainset":"string","cooldown":"string","coachNote":"string","paceTarget":"string","heartRateZone":"Zone 2"}]}. The days array MUST use the field names: day, type, name, duration, effort, zone, purpose, warmup, mainset, cooldown, coachNote, paceTarget, heartRateZone. type MUST be one of: Swim, Bike, Run, Brick, Strength, Rest, Race. Never use workouts, details, intensity, discipline or any other field names. VOLUME RULES: For Full Ironman plans — long ride must build to 5-6 hours (160-180km) in Peak phase, never cap long ride under 3.5 hours in Build or Peak. Long run builds to 2.5 hours in Peak. For 70.3 — long ride peaks at 3-4 hours. Always match session volumes to the race distance in the original prompt. ${restDayRule} ${taperRule} ${raceDayRule}`;

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

    const allWeeks = [...(planData.weeks || []), ...newWeeks];
    allWeeks.forEach((wk, i) => { wk.weekNumber = i + 1; });

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
