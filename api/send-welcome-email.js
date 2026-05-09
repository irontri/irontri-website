export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const firstName = (name || 'Athlete').split(' ')[0];

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Welcome to irontri</title>
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

            <p style="font-size:22px;font-weight:700;color:#fff;margin:0 0 8px 0;line-height:1.3;">Hey ${firstName}, your plan is ready 🎉</p>
            <p style="font-size:15px;color:rgba(255,255,255,0.6);margin:0 0 8px 0;line-height:1.6;">Welcome to irontri. Your 7-day free trial starts now — here's how to make the most of it.</p>

            <!-- TRIAL BANNER -->
            <div style="background:rgba(30,144,255,0.08);border:1px solid rgba(30,144,255,0.25);border-radius:12px;padding:14px 18px;margin-bottom:28px;font-size:14px;color:rgba(255,255,255,0.7);line-height:1.6;">
              ⏳ <strong style="color:#fff;">7-day free trial</strong> — full access to your plan, AI coach and Strava sync. No credit card needed to get started.
            </div>

            <!-- DIVIDER -->
            <div style="height:1px;background:rgba(255,255,255,0.08);margin-bottom:28px;"></div>

            <!-- STEP 1 -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px;">
              <tr>
                <td width="40" valign="top">
                  <div style="width:32px;height:32px;background:rgba(30,144,255,0.15);border:1px solid rgba(30,144,255,0.3);border-radius:50%;text-align:center;line-height:32px;font-size:14px;font-weight:700;color:#1E90FF;">1</div>
                </td>
                <td valign="top" style="padding-left:12px;">
                  <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;">Open your training plan</div>
                  <div style="font-size:14px;color:rgba(255,255,255,0.5);line-height:1.5;">Every session is built around your fitness, your schedule, and your race — all the way to race day. Tap "Today" to see what's on.</div>
                </td>
              </tr>
            </table>

            <!-- STEP 2 -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px;">
              <tr>
                <td width="40" valign="top">
                  <div style="width:32px;height:32px;background:rgba(30,144,255,0.15);border:1px solid rgba(30,144,255,0.3);border-radius:50%;text-align:center;line-height:32px;font-size:14px;font-weight:700;color:#1E90FF;">2</div>
                </td>
                <td valign="top" style="padding-left:12px;">
                  <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;">Connect Strava</div>
                  <div style="font-size:14px;color:rgba(255,255,255,0.5);line-height:1.5;">Link Strava and irontri will auto-tick sessions when you complete them. Your HR zones, pace and power targets are calculated from your real data.</div>
                </td>
              </tr>
            </table>

            <!-- STEP 3 -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px;">
              <tr>
                <td width="40" valign="top">
                  <div style="width:32px;height:32px;background:rgba(30,144,255,0.15);border:1px solid rgba(30,144,255,0.3);border-radius:50%;text-align:center;line-height:32px;font-size:14px;font-weight:700;color:#1E90FF;">3</div>
                </td>
                <td valign="top" style="padding-left:12px;">
                  <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;">Ask Trixy anything</div>
                  <div style="font-size:14px;color:rgba(255,255,255,0.5);line-height:1.5;">Trixy is your AI triathlon coach — tap the Coach tab and ask anything about your plan, your sessions, your race, or your training. Available 24/7.</div>
                </td>
              </tr>
            </table>

            <!-- STEP 4 -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px;">
              <tr>
                <td width="40" valign="top">
                  <div style="width:32px;height:32px;background:rgba(30,144,255,0.15);border:1px solid rgba(30,144,255,0.3);border-radius:50%;text-align:center;line-height:32px;font-size:14px;font-weight:700;color:#1E90FF;">4</div>
                </td>
                <td valign="top" style="padding-left:12px;">
                  <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;">Download the app</div>
                  <div style="font-size:14px;color:rgba(255,255,255,0.5);line-height:1.5;">Train on the go — irontri is available on iOS and Android. Same plan, same coach, everywhere.</div>
                  <div style="margin-top:8px;">
                    <a href="https://apps.apple.com/au/app/irontri-triathlon-training/id6762278379" style="display:inline-block;background:rgba(255,255,255,0.08);color:#fff;font-size:12px;font-weight:600;text-decoration:none;padding:6px 14px;border-radius:8px;margin-right:8px;border:1px solid rgba(255,255,255,0.12);">🍎 App Store</a>
                    <a href="https://play.google.com/store/apps/details?id=com.irontri.app" style="display:inline-block;background:rgba(255,255,255,0.08);color:#fff;font-size:12px;font-weight:600;text-decoration:none;padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);">🤖 Google Play</a>
                  </div>
                </td>
              </tr>
            </table>

            <!-- DIVIDER -->
            <div style="height:1px;background:rgba(255,255,255,0.08);margin-bottom:28px;"></div>

            <!-- CTA -->
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td align="center">
                  <a href="https://www.irontriapp.com/dashboard.html" style="display:inline-block;background:#1E90FF;color:#fff;font-size:16px;font-weight:600;text-decoration:none;padding:16px 40px;border-radius:12px;letter-spacing:-0.3px;">Open my plan →</a>
                </td>
              </tr>
            </table>

            <!-- PERSONAL NOTE -->
            <div style="margin-top:36px;padding:20px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;">
              <p style="font-size:14px;color:rgba(255,255,255,0.6);line-height:1.6;margin:0 0 12px 0;">I built irontri because I couldn't find a training plan that actually fit my life — so I made one that adapts to yours. I'm currently training on it myself for Ironman Busselton in December. If anything feels off about your plan, just reply to this email and I'll sort it personally.</p>
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

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: 'Dean from irontri <coach@irontriapp.com>',
        to: [email],
        subject: `Your irontri plan is ready, ${firstName} 🏊🚴🏃`,
        html
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Email failed to send' });
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Welcome email error:', e);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
