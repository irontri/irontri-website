export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, subject, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'irontri <coach@irontriapp.com>',
        to: ['coach@irontriapp.com'],
        reply_to: email,
        subject: subject ? `[irontri contact] ${subject}` : `[irontri contact] Message from ${name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
            <div style="background:#1E90FF;padding:24px 32px;">
              <h2 style="margin:0;font-size:20px;font-weight:700;">New contact message</h2>
              <p style="margin:4px 0 0;opacity:0.8;font-size:14px;">via irontriapp.com/contact</p>
            </div>
            <div style="padding:32px;">
              <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;color:rgba(255,255,255,0.5);width:80px;">Name</td>
                  <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:15px;font-weight:500;">${name}</td>
                </tr>
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;color:rgba(255,255,255,0.5);">Email</td>
                  <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:15px;"><a href="mailto:${email}" style="color:#1E90FF;">${email}</a></td>
                </tr>
                ${subject ? `<tr>
                  <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;color:rgba(255,255,255,0.5);">Subject</td>
                  <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:15px;">${subject}</td>
                </tr>` : ''}
              </table>
              <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:20px;">
                <p style="font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;">Message</p>
                <p style="font-size:15px;line-height:1.7;white-space:pre-wrap;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
              </div>
              <div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.08);">
                <a href="mailto:${email}?subject=Re: ${encodeURIComponent(subject || 'Your irontri message')}" style="display:inline-block;background:#1E90FF;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;">Reply to ${name} →</a>
              </div>
            </div>
          </div>
        `
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.status(200).json({ success: true });
  } catch(e) {
    console.error('Contact handler error:', e);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
