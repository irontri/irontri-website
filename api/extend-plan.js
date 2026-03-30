export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { planContext, startWeek, numWeeks, race, userId, planId } = req.body;

  const prompt = `You are an expert triathlon coach. You are extending an existing training plan.

EXISTING PLAN CONTEXT:
${JSON.stringify(planContext, null, 2)}

Generate weeks ${startWeek} to ${startWeek + numWeeks - 1} of this plan, continuing logically from the previous weeks.
- Maintain the same athlete context (race, fitness level, available hours)
- Progress the load appropriately from where the plan left off
- Follow the same periodisation structure (build, peak, taper based on race proximity)
- Use the same JSON structure as existing weeks
- Race: ${race || 'Triathlon'}

CRITICAL: Respond with ONLY valid JSON. No markdown, no explanation. Format:
{
  "weeks": [
    {
      "weekNum": ${startWeek},
      "phase": "Build",
      "weeklyNarrative": "...",
      "totalVolume": "...",
      "days": [
        {
          "day": "Monday",
          "type": "Swim",
          "name": "Session name",
          "duration": 45,
          "effort": 6,
          "paceTarget": "1:45/100m",
          "purpose": "...",
          "intervals": "..."
        }
      ]
    }
  ]
}`;

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
        max_tokens: 12000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'Plan extension failed. Please try again.' });
    }

    const data = await response.json();
    const planText = data.content.map(c => c.text || '').join('\n');

    // Save extended plan to Supabase if we have userId and planId
    if (userId && planId) {
      try {
        await fetch(process.env.SUPABASE_URL + '/rest/v1/plans?id=eq.' + planId, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ plan_data: planText })
        });
      } catch(e) {
        console.log('Could not save extended plan:', e);
      }
    }

    return res.status(200).json({ plan: planText });
  } catch(e) {
    console.error('Handler error:', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
