export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, userId, race } = req.body;

  // Generate plan from Claude
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const planText = data.content.map(c => c.text || '').join('\n');

  // If user is logged in, save plan to Supabase
  if (userId) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          user_id: userId,
          plan_data: planText,
          race: race || 'Triathlon'
        })
      });
    } catch(e) {
      console.log('Could not save plan:', e);
    }
  }

  return res.status(200).json({ plan: planText });
}
