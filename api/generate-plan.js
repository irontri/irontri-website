export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, userId, race } = req.body;

  const systemPrompt = `You are an elite triathlon coach generating structured training plans.

ALWAYS return ONLY valid JSON — no markdown, no backticks, no explanation.

SESSION QUALITY RULES (apply to every session):
- Names: evocative and specific e.g. "Threshold Fortress" not "Bike Intervals"
- Mainset: exact intervals, exact rest, exact pace/watts/cadence + one technique cue
- Bike: always include cadence (rpm) + realistic speed (km/h) + power (% FTP or watts)
- Run: always include pace (/km) + cadence (spm) + technique cue
- Swim: always include interval distance + rest + technique cue
- coachNote: explain WHY this session exists this week
- weeklyNarrative: 2 sentences on the week's purpose
- day field: day name e.g. "Monday" not a number
- type field: capitalised e.g. "Swim", "Bike", "Run", "Brick", "Strength", "Rest"

REALISTIC PACE TARGETS BY LEVEL (use the athlete's experience to set appropriate targets):
- Beginner cyclist: 20-28 km/h. Do NOT set targets above 30 km/h for beginners.
- Intermediate cyclist: 28-34 km/h
- Advanced cyclist: 34-40 km/h
- Beginner runner: 6:30-8:00 /km. Do NOT set sub-6:00 /km for beginners.
- Intermediate runner: 5:00-6:30 /km
- Advanced runner: 4:00-5:00 /km
- Beginner swimmer: 2:00-2:30 /100m
- Intermediate swimmer: 1:40-2:00 /100m
- Advanced swimmer: 1:20-1:40 /100m
PROGRESSIVE OVERLOAD: Targets must build GRADUALLY week to week — max 2-3% improvement per week. Week 1 targets must match current fitness, NOT goal race pace. Do NOT set week 1 targets at race-finish pace."

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
        max_tokens: 4000,
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
