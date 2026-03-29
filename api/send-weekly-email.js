const { createClient } = require('@supabase/supabase-js');

export const config = { maxDuration: 60 };

const SUPABASE_URL = 'https://aezfxagplaxlmovqbmfd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = 'coach@irontriapp.com';

const TYPE_EMOJI = {
  Swim: '🏊', Bike: '🚴', Run: '🏃', Brick: '🔥',
  Strength: '💪', Rest: '😴', Race: '🏁'
};

function fmtDur(mins) {
  if (!mins) return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getWeekForUser(planData) {
  const startDate = planData.startDate;
  if (!startDate) return null;
  const start = new Date(startDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - start) / 86400000);
  if (diffDays < 0) return null;
  const weekIdx = Math.floor(diffDays / 7);
  if (weekIdx >= planData.weeks.length) return null;
  return { week: planData.weeks[weekIdx], weekNum: weekIdx + 1 };
}

function buildEmailHTML(name, race, weekNum, phase, sessions, totalMins, days) {
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const totalStr = hrs > 0 ? `${hrs}h${mins > 0 ? mins + 'm' : ''}` : `${mins}m`;
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const sessionRows = days.map((d, i) => {
    if (d.type === 'Rest') return '';
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #1a1a1a;">
          <span style="font-size:18px;margin-right:10px;">${TYPE_EMOJI[d.type] || '🏋️'}</span>
          <strong style="color:#fff;">${dayNames[i]}</strong>
          <span style="color:#888;margin:0 8px;">·</span>
          <span style="color:#ccc;">${d.name || d.type + ' Session'}</span>
          <span style="color:#555;margin-left:8px;font-size:13px;">${d.duration ? fmtDur(d.duration) : ''}</span>
        </td>
      </tr>`;
  }).join('');

  const firstName = name ? name.split(' ')[0] : 'Athlete';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'DM Sans',Arial,sans-serif;color:#fff;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">

    <!-- Header -->
    <div style="margin-bottom:32px;">
      <div style="font-size:22px;font-weight:800;letter-spacing:-1px;color:#1E90FF;margin-bottom:4px;">irontri</div>
      <div style="font-size:13px;color:#555;">Personalised triathlon coaching</div>
    </div>

    <!-- Greeting -->
    <div style="margin-bottom:28px;">
      <h1 style="font-size:26px;font-weight:800;letter-spacing:-0.5px;margin:0 0 8px 0;">
        Your week ahead, ${firstName} 💪
      </h1>
      <p style="color:#888;font-size:15px;margin:0;">
        Week ${weekNum} · ${phase} Phase · ${sessions} sessions · ${totalStr}
      </p>
    </div>

    <!-- Week summary card -->
    <div style="background:#111;border:1px solid #222;border-radius:14px;padding:24px;margin-bottom:24px;">
      <table style="width:100%;border-collapse:collapse;">
        ${sessionRows || '<tr><td style="color:#555;padding:10px 0;">Rest week — recover well.</td></tr>'}
      </table>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:32px;">
      <a href="https://www.irontriapp.com/dashboard.html"
         style="display:inline-block;background:#1E90FF;color:#fff;text-decoration:none;
                padding:14px 36px;border-radius:10px;font-size:15px;font-weight:600;">
        Open my plan →
      </a>
    </div>

    <!-- Coach note -->
    <div style="background:#111;border-left:3px solid #1E90FF;padding:16px 20px;border-radius:0 10px 10px 0;margin-bottom:32px;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:#1E90FF;margin-bottom:6px;">Coach note</div>
      <div style="font-size:14px;color:#aaa;line-height:1.6;">
        Every session this week has a purpose. Trust the process — consistency beats perfection every time.
        If life gets in the way, swap or skip rather than abandon. See you on the other side. 🏁
      </div>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #1a1a1a;padding-top:20px;text-align:center;">
      <p style="color:#444;font-size:12px;margin:0 0 8px 0;">
        You're receiving this because you have an active training plan on irontri.
      </p>
      <p style="color:#333;font-size:12px;margin:0;">
        <a href="https://www.irontriapp.com/dashboard.html" style="color:#555;">Dashboard</a>
        &nbsp;·&nbsp;
        <a href="https://www.irontriapp.com" style="color:#555;">irontriapp.com</a>
      </p>
    </div>

  </div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  // Allow manual trigger via POST, or cron via GET
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Security: require secret for manual POST triggers
  if (req.method === 'POST') {
    const { secret } = req.body || {};
    if (secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Supabase key not set' });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // Get all users with their most recent plan
    const { data: plans, error } = await sb
      .from('plans')
      .select('id, user_id, race, plan_data, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Deduplicate — keep only most recent plan per user
    const byUser = {};
    for (const plan of plans) {
      if (!byUser[plan.user_id]) byUser[plan.user_id] = plan;
    }

    // Get user emails from auth
    const userIds = Object.keys(byUser);
    const results = { sent: 0, skipped: 0, errors: [] };

    for (const userId of userIds) {
      try {
        const plan = byUser[userId];

        // Get user email
        const { data: userData } = await sb.auth.admin.getUserById(userId);
        const email = userData?.user?.email;
        const name = userData?.user?.user_metadata?.name || 'Athlete';
        if (!email) { results.skipped++; continue; }

        // Parse plan data
        let planData;
        try {
          let txt = plan.plan_data || '';
          txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
          planData = JSON.parse(txt);
        } catch(e) { results.skipped++; continue; }

        // Use created_at as fallback for startDate
        if (!planData.startDate && plan.created_at) {
          planData.startDate = plan.created_at.split('T')[0];
        }

        const weekInfo = getWeekForUser(planData);
        if (!weekInfo) { results.skipped++; continue; }

        const { week, weekNum } = weekInfo;
        const sessions = week.days.filter(d => d.type !== 'Rest').length;
        const totalMins = week.days.reduce((a, d) => a + (d.duration || 0), 0);

        // Build and send email
        const html = buildEmailHTML(name, plan.race, weekNum, week.phase || 'Base', sessions, totalMins, week.days);

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: FROM,
            to: email,
            subject: `Your week ahead, ${name.split(' ')[0]} 💪 — Week ${weekNum} · ${week.phase || 'Base'} Phase`,
            html
          })
        });

        if (emailRes.ok) {
          results.sent++;
        } else {
          const err = await emailRes.json();
          results.errors.push({ email, error: err });
        }

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 100));

      } catch(e) {
        results.errors.push({ userId, error: e.message });
      }
    }

    return res.status(200).json({
      success: true,
      ...results,
      timestamp: new Date().toISOString()
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
