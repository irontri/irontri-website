export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Allow Vercel cron or manual trigger
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Get all non-paid, non-founding plans with user emails
  const { data: plans, error } = await supabase
    .from('plans')
    .select('id, user_id, created_at')
    .eq('is_paid', false)
    .eq('is_founding_member', false);

  if (error) {
    console.error('Supabase error:', error);
    return res.status(500).json({ error: error.message });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sent = [];

  for (const plan of plans) {
    const created = new Date(plan.created_at);
    created.setHours(0, 0, 0, 0);
    const days = Math.floor((today - created) / (1000 * 60 * 60 * 24));

    if (![21, 27, 29].includes(days)) continue;

    // Get user email from auth.users via service role
    const { data: userData } = await supabase.auth.admin.getUserById(plan.user_id);
    if (!userData?.user?.email) continue;

    const email = userData.user.email;
    const name = email.split('@')[0];
    const firstName = name.charAt(0).toUpperCase() + name.slice(1);
    const daysLeft = 30 - days;
    const planUrl = `https://www.irontriapp.com/plan.html?load=${plan.id}`;

    const subject = days === 21
      ? `Your irontri trial — ${daysLeft} days left`
      : days === 27
      ? `3 days left on your irontri trial`
      : `Last day tomorrow — keep your plan going`;

    const headline = days === 21
      ? `You've got ${daysLeft} days left on your free trial`
      : days === 27
      ? `Your trial ends in 3 days`
      : `Your trial ends tomorrow`;

    const message = days === 21
      ? `You're almost 3 weeks into your training plan. Keep the momentum going — your plan continues all the way to race day when you upgrade.`
      : days === 27
      ? `You've been training hard. Don't let your plan stop now — upgrade to keep every session, every week, right through to race day.`
      : `Tomorrow is the last day of your free trial. After that, your next weeks will be locked. Upgrade today to keep training without interruption.`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
  <tr>
    <td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- HEADER -->
        <tr>
          <td style="background:#1E90FF;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
            <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">irontri</div>
            <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px;letter-spacing:1px;text-transform:uppercase;">Personalised Triathlon Training</div>
          </td>
        </tr>

        <!-- BODY -->
        <tr>
          <td style="background:#141414;border:1px solid rgba(255,255,255,0.08);padding:40px;border-radius:0 0 16px 16px;">

            <p style="font-size:22px;font-weight:700;color:#fff;margin:0 0 8px 0;line-height:1.3;">Hey ${firstName}, ${headline}</p>
            <p style="font-size:15px;color:rgba(255,255,255,0.6);margin:0 0 28px 0;line-height:1.6;">${message}</p>

            <!-- DIVIDER -->
            <div style="height:1px;background:rgba(255,255,255,0.08);margin-bottom:28px;"></div>

            <!-- PRICING BOX -->
            <div style="background:rgba(30,144,255,0.08);border:1px solid rgba(30,144,255,0.25);border-radius:14px;padding:24px;text-align:center;margin-bottom:28px;">
              <div style="font-size:36px;font-weight:900;color:#1E90FF;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;letter-spacing:-1px;">$20<span style="font-size:16px;font-weight:400;color:rgba(255,255,255,0.4)">/month</span></div>
              <div style="font-size:13px;color:rgba(255,255,255,0.4);margin:4px 0 16px;">Cancel anytime · No lock-in</div>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 0;text-align:left;">
                <tr><td style="font-size:14px;color:rgba(255,255,255,0.7);padding:4px 0;"><span style="color:#1E90FF;margin-right:8px;">✓</span>Full plan to race day</td></tr>
                <tr><td style="font-size:14px;color:rgba(255,255,255,0.7);padding:4px 0;"><span style="color:#1E90FF;margin-right:8px;">✓</span>AI-adaptive coaching</td></tr>
                <tr><td style="font-size:14px;color:rgba(255,255,255,0.7);padding:4px 0;"><span style="color:#1E90FF;margin-right:8px;">✓</span>Strava sync</td></tr>
                <tr><td style="font-size:14px;color:rgba(255,255,255,0.7);padding:4px 0;"><span style="color:#1E90FF;margin-right:8px;">✓</span>Swim, bike &amp; run sessions</td></tr>
              </table>
            </div>

            <!-- CTA -->
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td align="center">
                  <a href="${planUrl}" style="display:inline-block;background:#1E90FF;color:#fff;font-size:16px;font-weight:600;text-decoration:none;padding:16px 40px;border-radius:12px;letter-spacing:-0.3px;">Continue my plan →</a>
                </td>
              </tr>
            </table>

            <!-- PERSONAL NOTE -->
            <div style="margin-top:36px;padding:20px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;">
              <p style="font-size:14px;color:rgba(255,255,255,0.6);line-height:1.6;margin:0 0 12px 0;">I built irontri because I couldn't find a training plan that actually fit my life — so I made one that adapts to yours. If you have any questions before upgrading, just reply to this email.</p>
              <p style="font-size:14px;color:rgba(255,255,255,0.5);margin:0;">— Dean, founder of irontri</p>
            </div>

          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="padding:24px 0;text-align:center;">
            <p style="font-size:12px;color:rgba(255,255,255,0.25);margin:0;">© 2026 irontri · <a href="https://www.irontriapp.com" style="color:rgba(255,255,255,0.25);text-decoration:none;">irontriapp.com</a></p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: 'Dean from irontri <coach@irontriapp.com>',
        to: [email],
        subject,
        html
      })
    });

    if (r.ok) {
      sent.push({ email, days });
      console.log(`Sent day-${days} reminder to ${email}`);
    } else {
      console.error(`Failed to send to ${email}:`, await r.text());
    }
  }

  return res.status(200).json({ sent, total: sent.length });
}
