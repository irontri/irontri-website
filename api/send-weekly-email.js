export const config = { maxDuration: 60 };

const SUPABASE_URL = 'https://aezfxagplaxlmovqbmfd.supabase.co';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FROM = 'coach@irontriapp.com';

const TYPE_EMOJI = {
  Swim:'🏊', Bike:'🚴', Run:'🏃', Brick:'🔥',
  Strength:'💪', Rest:'😴', Race:'🏁'
};

function fmtDur(mins) {
  if (!mins) return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins/60), m = mins%60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getWeekForUser(planData, createdAt) {
  const startDateStr = planData.startDate || (createdAt ? createdAt.split('T')[0] : null);
  if (!startDateStr) return null;
  const start = new Date(startDateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0,0,0,0);
  const diffDays = Math.round((today - start) / 86400000);
  if (diffDays < 0) return null;
  const weekIdx = Math.floor(diffDays / 7);
  if (!planData.weeks || weekIdx >= planData.weeks.length) return null;
  return { week: planData.weeks[weekIdx], weekNum: weekIdx + 1 };
}

function buildEmailHTML(firstName, race, weekNum, phase, totalMins, days) {
  const hrs = Math.floor(totalMins/60), mins = totalMins%60;
  const totalStr = hrs > 0 ? `${hrs}h${mins > 0 ? mins+'m' : ''}` : `${mins}m`;
  const sessions = days.filter(d => d.type !== 'Rest').length;
  const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  const rows = days.map((d,i) => {
    if (d.type === 'Rest') return '';
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #1e1e1e;">
        <span style="font-size:16px;margin-right:10px;">${TYPE_EMOJI[d.type]||'🏋️'}</span>
        <strong style="color:#fff;">${dayNames[i]}</strong>
        <span style="color:#666;margin:0 8px;">·</span>
        <span style="color:#ccc;">${d.name||d.type+' Session'}</span>
        <span style="color:#444;margin-left:8px;font-size:12px;">${d.duration?fmtDur(d.duration):''}</span>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,sans-serif;color:#fff;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;">
  <div style="margin-bottom:28px;">
    <div style="font-size:20px;font-weight:800;color:#1E90FF;margin-bottom:2px;">irontri</div>
    <div style="font-size:12px;color:#444;">Personalised triathlon coaching</div>
  </div>
  <h1 style="font-size:24px;font-weight:800;margin:0 0 8px 0;">Your week ahead, ${firstName} 💪</h1>
  <p style="color:#666;font-size:14px;margin:0 0 24px 0;">Week ${weekNum} · ${phase||'Base'} Phase · ${sessions} sessions · ${totalStr}</p>
  <div style="background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:20px;margin-bottom:24px;">
    <table style="width:100%;border-collapse:collapse;">${rows||'<tr><td style="color:#555;padding:10px 0;">Recovery week — rest up.</td></tr>'}</table>
  </div>
  <div style="text-align:center;margin-bottom:28px;">
    <a href="https://www.irontriapp.com/dashboard.html" style="display:inline-block;background:#1E90FF;color:#fff;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:15px;font-weight:600;">Open my plan →</a>
  </div>
  <div style="background:#111;border-left:3px solid #1E90FF;padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:28px;">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#1E90FF;margin-bottom:6px;">Coach note</div>
    <div style="font-size:13px;color:#aaa;line-height:1.6;">Consistency beats perfection. If life gets in the way this week, swap or skip rather than abandon. Every session counts. 🏁</div>
  </div>
  <div style="border-top:1px solid #1a1a1a;padding-top:16px;text-align:center;">
    <p style="color:#333;font-size:12px;margin:0;">You're receiving this because you have an active plan on <a href="https://www.irontriapp.com" style="color:#444;">irontriapp.com</a></p>
  </div>
</div>
</body></html>`;
}

export default async function handler(req, res) {
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not set' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set' });

  try {
    // Get all plans
    const plansRes = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?select=id,user_id,race,plan_data,created_at&order=created_at.desc`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const plans = await plansRes.json();

    // Dedupe — most recent plan per user
    const byUser = {};
    for (const plan of plans) {
      if (!byUser[plan.user_id]) byUser[plan.user_id] = plan;
    }

    const results = { sent: 0, skipped: 0, errors: [] };

    for (const userId of Object.keys(byUser)) {
      try {
        const plan = byUser[userId];

        // Get user email via admin API
        const userRes = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users/${userId}`,
          { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
        );
        const userData = await userRes.json();
        const email = userData?.email;
        const name = userData?.user_metadata?.name || userData?.raw_user_meta_data?.name || 'Athlete';
        const firstName = name.split(' ')[0];
        if (!email) { results.skipped++; continue; }

        // Parse plan
        let planData;
        try {
          let txt = plan.plan_data || '';
          txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}')+1);
          planData = JSON.parse(txt);
        } catch(e) { results.skipped++; continue; }

        const weekInfo = getWeekForUser(planData, plan.created_at);
        if (!weekInfo) { results.skipped++; continue; }

        const { week, weekNum } = weekInfo;
        const totalMins = week.days.reduce((a,d) => a+(d.duration||0), 0);

        const html = buildEmailHTML(firstName, plan.race, weekNum, week.phase, totalMins, week.days);

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM,
            to: email,
            subject: `Your week ahead, ${firstName} 💪 — Week ${weekNum} · ${week.phase||'Base'} Phase`,
            html
          })
        });

        if (emailRes.ok) { results.sent++; }
        else { const err = await emailRes.json(); results.errors.push({ email, error: err }); }

        await new Promise(r => setTimeout(r, 100));
      } catch(e) {
        results.errors.push({ userId, error: e.message });
      }
    }

    return res.status(200).json({ success: true, ...results, timestamp: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
