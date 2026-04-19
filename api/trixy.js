export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { systemPrompt, history, message } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  try {
    // Build messages array from history
    const messages = [];
    if (history && Array.isArray(history)) {
      history.forEach(m => {
        if (m.role && m.content) {
          messages.push({ role: m.role, content: m.content });
        }
      });
    }
    messages.push({ role: 'user', content: message });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system: systemPrompt || 'You are Trixy, a personal triathlon coach. Be warm, direct and concise.',
        messages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Trixy API error:', err);
      return res.status(500).json({ error: 'Coach unavailable, try again.' });
    }

    const data = await response.json();
    const reply = data.content?.map(c => c.text || '').join('') || "Give me a sec and try again!";
    return res.status(200).json({ reply });

  } catch(e) {
    console.error('Trixy handler error:', e);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
