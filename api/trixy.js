export const config = { maxDuration: 30 };

// Limits on what a single request can ask for. The web and mobile clients ask for
// 300 tokens (chat) or 800 (session rewrite) and send far less text than these caps,
// so real members never hit them. They stop the endpoint being used to run very
// large or very long requests on the irontri API key.
const MAX_OUTPUT_TOKENS = 1000;
const MAX_SYSTEM_CHARS = 100000;
const MAX_MESSAGE_CHARS = 30000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 60000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { systemPrompt, history, message, max_tokens } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Missing message' });
  if (message.length > MAX_MESSAGE_CHARS) return res.status(413).json({ error: 'Message too long' });
  if (systemPrompt != null && (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_CHARS)) {
    return res.status(413).json({ error: 'Context too long' });
  }

  // Never let the caller ask for more output than the clients actually use.
  const requestedTokens = Number(max_tokens);
  const outputTokens = Number.isFinite(requestedTokens) && requestedTokens > 0
    ? Math.min(Math.floor(requestedTokens), MAX_OUTPUT_TOKENS)
    : 300;

  try {
    // Keep only well-formed chat turns, and only the most recent ones if the chat is long.
    let turns = [];
    if (history && Array.isArray(history)) {
      history.forEach(m => {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
          turns.push({ role: m.role, content: m.content });
        }
      });
    }
    turns = turns.slice(-MAX_HISTORY_MESSAGES);
    let historyChars = turns.reduce((n, m) => n + m.content.length, 0);
    while (turns.length && historyChars > MAX_HISTORY_CHARS) {
      historyChars -= turns.shift().content.length;
    }
    // The API needs the conversation to open with a user turn.
    while (turns.length && turns[0].role !== 'user') turns.shift();

    const messages = turns;
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
        max_tokens: outputTokens,
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
