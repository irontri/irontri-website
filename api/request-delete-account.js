// api/request-delete-account.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://irontriapp.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, reason } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    // Send notification email via Resend
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'irontri <noreply@irontriapp.com>',
        to: 'irontriapp@gmail.com',
        subject: '⚠️ Account deletion request — ' + email,
        html: `
          <h2>Account Deletion Request</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Reason:</strong> ${reason || 'Not provided'}</p>
          <p><strong>Requested at:</strong> ${new Date().toISOString()}</p>
          <hr>
          <p>Delete this user's data from Supabase within 30 days.</p>
        `
      })
    });

    return res.status(200).json({ success: true });
  } catch(e) {
    console.error('Delete account request error:', e);
    return res.status(200).json({ success: true }); // still show success to user
  }
}
