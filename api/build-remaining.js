// api/build-remaining.js
// Vercel serverless function — generates remaining weeks for a plan server-side
// Called by the app after initial 4 weeks are saved. Runs entirely on Vercel.

export const config = { maxDuration: 120 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { planId, userId, basePrompt, totalWeeks } = req.body;
  if (!planId || !userId || !basePrompt || !totalWeeks) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Respond immediately so the app doesn't wait
  res.status(200).json({ success: true, message: 'Building remaining weeks in background' });

  // Now do the actual work after responding
  try {
    // Fetch current plan from Supabase
    const planRes = await fetch(`${SUPABASE_URL}/rest/v1/plans?id=eq.${planId}&user_id=eq.${userId}`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      }
    });
    const plans = await planRes.json();
    if (!plans || plans.length === 0) return;

    let txt = plans[0].plan_data || '';
    txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    const planData = JSON.parse(txt);
    let allWeeks = [...(planData.weeks || [])];
    const startFrom = allWeeks.length + 1;

    function parsePlan(txt) {
      txt = (txt || '').replace(/```json/g, '').replace(/```/g, '').trim();
      const s = txt.indexOf('{'); const e = txt.lastIndexOf('}');
      if (s === -1 || e === -1) throw new Error('No JSON');
      return JSON.parse(txt.slice(s, e + 1));
    }

    async function genWeeks(startWk, endWk) {
      const prompt = basePrompt + `Generate ONLY weeks ${startWk} to ${endWk} (weekNumber starting at ${startWk}). Return JSON: {"weeks":[...]} — array of ${endWk - startWk + 1} weeks only. No intro.`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
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
      const d = await r.json();
      const text = (d.content || []).map(c => c.text || '').join('');
      const parsed = parsePlan(text);
      return parsed.weeks || [];
    }

    async function saveWeeks(weeks) {
      const updated = { ...planData, weeks };
      await fetch(`${SUPABASE_URL}/rest/v1/plans?id=eq.${planId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ plan_data: JSON.stringify(updated) })
      });
    }

    // Generate remaining weeks in pairs, saving after each batch
    for (let i = startFrom; i <= totalWeeks; i += 2) {
      const end = Math.min(i + 1, totalWeeks);
      try {
        const newWks = await genWeeks(i, end);
        allWeeks = [...allWeeks, ...newWks];
        allWeeks.forEach((wk, idx) => { wk.weekNumber = idx + 1; });
        await saveWeeks(allWeeks);
      } catch (e) {
        console.error('Error generating weeks ' + i + '-' + end + ':', e.message);
        // Continue to next batch even if one fails
      }
    }
  } catch (e) {
    console.error('build-remaining error:', e.message);
  }
}
