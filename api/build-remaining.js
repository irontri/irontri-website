export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, userId, race } = req.body;

  // Detect units from prompt
  const isImperial = prompt && prompt.includes('imperial');

  const systemPrompt = `You are an elite triathlon coach generating structured training plans.

ALWAYS return ONLY valid JSON — no markdown, no backticks, no explanation.

UNITS: ${isImperial ? 'IMPERIAL — use miles, yards, mph, min/mile, min/100yd for ALL paces, speeds and distances. NEVER use km, km/h, or /100m.' : 'METRIC — use km, metres, km/h, min/km, min/100m for ALL paces, speeds and distances.'}

SESSION QUALITY RULES (apply to every session):
- Names: evocative and specific e.g. "Threshold Fortress" not "Bike Intervals"
- Mainset: exact intervals, exact rest, exact pace/watts/cadence + one technique cue
- Bike: always include cadence (rpm) + speed (${isImperial ? 'mph' : 'km/h'}) + power (% FTP or watts)
- Run: always include pace (${isImperial ? 'min/mile' : '/km'}) + cadence (spm) + technique cue
- Swim: always include interval distance (${isImperial ? 'yards' : 'metres'}) + rest + technique cue
- paceTarget: MUST be in ${isImperial ? 'min/mile or min/100yd or mph' : 'min/km or min/100m or km/h'} — NEVER mix units
- coachNote: explain WHY this session exists this week
- weeklyNarrative: 2 sentences on the week's purpose
- day field: day name e.g. "Monday" not a number
- type field: MUST be EXACTLY one of: "Swim", "Bike", "Run", "Brick", "Strength", "Rest" — NO other values allowed. Never use "Recovery", "Threshold", "Endurance", "Vo2max" or any other custom type.
- BRICK SESSIONS: Include at least 1 Brick session per week from Build phase onwards. A Brick session is a bike ride immediately followed by a run. Format mainset as: "Bike X km at [pace/watts], then immediately run Y km at [pace]. No rest between disciplines." Brick sessions are critical for race preparation and must appear consistently throughout the Build, Peak and Taper phases.
- BRICK REALISM: Brick session distances must be realistic for age groupers. The combined brick duration must NEVER exceed 40% of total weekly training hours. Run off the bike should be 6-16km for 70.3 builds and 10-25km for Full Ironman builds — NEVER a full marathon distance in training. Pace targets for the run off the bike must be 15-30 seconds per km SLOWER than standalone run pace to account for fatigue.

BASE PHASE RULES (critical — strictly enforced):
- During Base phase ALL sessions must be Zone 2 aerobic ONLY — effort 4-6/10, heartRateZone "Zone 2"
- ZERO threshold work, ZERO intervals, ZERO speedwork, ZERO VO2max efforts during Base phase
- Base swim: long continuous aerobic sets only — NO sprint sets, NO race-pace efforts, NO short hard intervals
- Base bike: steady aerobic riding at 55-65% FTP only — NO FTP intervals, NO over-unders, NO hard efforts
- Base run: easy conversational pace only — NO tempo runs, NO strides, NO track sessions, NO speed work
- Speedwork, threshold intervals and race-pace efforts begin ONLY from Build phase onwards — never before

PHASE ASSIGNMENT RULES (critical — must follow exactly):
- phase field MUST be one of: "Base", "Build", "Peak", "Taper", "Race Week"
- For a plan of N total weeks: Base = first 30%, Build = next 35%, Peak = next 20%, Taper = last 12%, Race Week = final 1 week
- Example 36-week plan: Base weeks 1-11, Build weeks 12-23, Peak weeks 24-29, Taper weeks 30-35, Race Week 36
- Example 20-week plan: Base weeks 1-6, Build weeks 7-13, Peak weeks 14-17, Taper weeks 18-19, Race Week 20
- Never assign "Base" to more than 35% of total weeks
- Recovery weeks within a phase keep the current phase label (e.g. a recovery week during Build is still "Build")

REALISTIC PACE TARGETS BY LEVEL:
- Beginner cyclist: ${isImperial ? '12-18 mph' : '20-28 km/h'}. Do NOT exceed ${isImperial ? '20 mph' : '30 km/h'} for beginners.
- Intermediate cyclist: ${isImperial ? '18-22 mph' : '28-34 km/h'}
- Advanced cyclist: ${isImperial ? '22-26 mph' : '34-40 km/h'}
- Beginner runner: ${isImperial ? '10:00-13:00 min/mile' : '6:30-8:00 /km'}
- Intermediate runner: ${isImperial ? '7:45-10:00 min/mile' : '5:00-6:30 /km'}
- Beginner swimmer: ${isImperial ? '2:10-2:45 /100yd' : '2:00-2:30 /100m'}
- Intermediate swimmer: ${isImperial ? '1:50-2:10 /100yd' : '1:40-2:00 /100m'}
PROGRESSIVE OVERLOAD: Max 2-3% improvement per week. Week 1 targets must match current fitness, NOT goal race pace.

RACE-SPECIFIC VOLUME RULES (critical — apply based on race distance in prompt):

FULL IRONMAN (140.6) LONG SESSION REQUIREMENTS:
- Long ride peak volume: 5-6 hours (${isImperial ? '100-120 miles' : '160-180 km'}) in Peak phase. Build progressively from 2.5h in Base to 5-6h at peak.
- Long run peak volume: 2-2.5 hours (${isImperial ? '16-20 miles' : '25-32 km'}) in Peak phase. Build from 60 min in Base.
- Weekly bike volume: 6-10 hours total at peak. Never less than 3 hours in any non-taper week.
- Never cap long ride at under 3.5 hours in Build or Peak phase for Full Ironman.

HALF IRONMAN (70.3) LONG SESSION REQUIREMENTS:
- Long ride peak: 3-4 hours (${isImperial ? '55-75 miles' : '90-120 km'}) in Peak phase.
- Long run peak: 1.5-2 hours (${isImperial ? '12-16 miles' : '18-24 km'}) in Peak phase.

OLYMPIC TRIATHLON LONG SESSION REQUIREMENTS:
- Long ride peak: 2-2.5 hours (${isImperial ? '35-50 miles' : '55-80 km'}) in Peak phase.
- Long run peak: 60-80 min (${isImperial ? '8-12 miles' : '12-18 km'}) in Peak phase.

SPRINT TRIATHLON LONG SESSION REQUIREMENTS:
- Long ride peak: 60-90 min (${isImperial ? '18-28 miles' : '30-45 km'}) in Peak phase.
- Long run peak: 45-60 min (${isImperial ? '5-8 miles' : '8-12 km'}) in Peak phase.

TAPER RULES (race-distance specific — apply strictly):
- Full Ironman / Half Ironman: Final 3 weeks taper — reduce volume by 30%, 50%, 70% respectively. Keep intensity.
- Olympic Triathlon: Final 2 weeks taper — reduce volume by 40%, 70% respectively. Keep intensity.
- Sprint Triathlon: Final 4-5 DAYS only — reduce volume by 40-60%. No dedicated taper week for sprint plans under 8 weeks. Last full training day is 2 days before race day.
- Never apply a multi-week taper to a sprint plan — it wastes valuable training time.

RACE DAY RULES (critical — must always be included):
- The FINAL day of the FINAL week must ALWAYS be a Race Day session with type "Race".
- Race Day session must have: name "Race Day 🏁", type "Race", effort 9, purpose "Your race — execute your plan and enjoy every moment.", a mainset describing the race distances (e.g. "750m swim, 20km bike, 5km run — race pace throughout"), coachNote with final race execution tips.
- The day before race day must always be type "Rest" with a short activation note (e.g. 5-10 min easy shakeout optional).
- Race Week phase must always contain the actual Race Day session — never end on a Rest day.

JSON structure for weeks:
{"weeks":[{"weekNumber":1,"phase":"Base","focus":"string","weeklyNarrative":"string","days":[{"day":"Monday","type":"Swim","name":"string","duration":45,"effort":5,"zone":2,"purpose":"string","warmup":"string","mainset":"string","cooldown":"string","coachNote":"string","paceTarget":"string","heartRateZone":"Zone 2"}]}]}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'Plan generation failed. Please try again.' });
    }

    const data = await response.json();
    const planText = data.content.map(c => c.text || '').join('\n');

    if (userId) {
      try {
        await fetch(process.env.SUPABASE_URL + '/rest/v1/plans', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ user_id: userId, plan_data: planText, race: race || 'Triathlon' })
        });
      } catch(e) {
        console.log('Could not save plan:', e);
      }
    }

    return res.status(200).json({ plan: planText });
  } catch(e) {
    console.error('Handler error:', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
