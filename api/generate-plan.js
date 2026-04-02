export const config = { maxDuration: 60 };

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
- type field: capitalised e.g. "Swim", "Bike", "Run", "Brick", "Strength", "Rest"

REALISTIC PACE TARGETS BY LEVEL:
- Beginner cyclist: ${isImperial ? '12-18 mph' : '20-28 km/h'}. Do NOT exceed ${isImperial ? '20 mph' : '30 km/h'} for beginners.
- Intermediate cyclist: ${isImperial ? '18-22 mph' : '28-34 km/h'}
- Advanced cyclist: ${isImperial ? '22-26 mph' : '34-40 km/h'}
- Beginner runner: ${isImperial ? '10:00-13:00 min/mile' : '6:30-8:00 /km'}
- Intermediate runner: ${isImperial ? '7:45-10:00 min/mile' : '5:00-6:30 /km'}
- Beginner swimmer: ${isImperial ? '2:10-2:45 /100yd' : '2:00-2:30 /100m'}
- Intermediate swimmer: ${isImperial ? '1:50-2:10 /100yd' : '1:40-2:00 /100m'}
PROGRESSIVE OVERLOAD: Max 2-3% improvement per week. Week 1 targets must match current fitness, NOT goal race pace.

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
        max_tokens: 8000,
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
