export const config = { maxDuration: 60, api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  // Read raw body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Verify Stripe signature
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const { createHmac } = await import('crypto');
    const parts = sig.split(',');
    let timestamp = '', signature = '';
    for (const part of parts) {
      const [key, val] = part.split('=');
      if (key === 't') timestamp = val;
      if (key === 'v1') signature = val;
    }
    const expected = createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
    if (expected !== signature) return res.status(400).json({ error: 'Invalid signature' });
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };

  async function markUserPaid(email, subscriptionId) {
    if (!email) return;
    console.log('Marking paid:', email);
    const userRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } }
    );
    const userData = await userRes.json();
    const userId = userData?.users?.[0]?.id;
    if (!userId) return console.error('No user found:', email);
    await fetch(`${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ is_paid: true, stripe_subscription_id: subscriptionId || null })
    });
    console.log('Plan marked paid for:', email);
  }

  async function sendWelcomeEmail(email, name) {
    if (!email || !RESEND_API_KEY) return;
    const firstName = name ? name.split(' ')[0] : 'there';
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Dean at irontri <coach@irontriapp.com>',
        to: email,
        subject: 'Welcome to irontri — you\'re officially in 🏊🚴🏃',
        html: `
          <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;background:#0d0d0d;padding:40px 20px;">
            <div style="max-width:560px;margin:0 auto;">
              <div style="font-size:22px;font-weight:800;color:#1E90FF;margin-bottom:32px;">irontri</div>
              <h1 style="font-size:26px;font-weight:800;color:#fff;margin:0 0 16px;">Welcome to irontri, ${firstName}! 🎉</h1>
              <p style="font-size:15px;color:rgba(255,255,255,0.7);line-height:1.7;margin:0 0 16px;">
                You're now a paid member — thank you so much for believing in what we're building here.
              </p>
              <p style="font-size:15px;color:rgba(255,255,255,0.7);line-height:1.7;margin:0 0 24px;">
                Your training plan is ready and waiting. Head to your dashboard to see today's session and start training smarter.
              </p>
              <a href="https://irontriapp.com/dashboard.html" style="display:inline-block;background:#1E90FF;color:#fff;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:700;text-decoration:none;margin-bottom:32px;">
                Go to my dashboard →
              </a>
              <p style="font-size:14px;color:rgba(255,255,255,0.5);line-height:1.7;margin:0 0 8px;">
                If you ever need to manage your subscription — update your card or cancel — you can do that anytime from your profile page.
              </p>
              <p style="font-size:14px;color:rgba(255,255,255,0.5);margin:0;">
                Any questions? Just reply to this email — I read every one.
              </p>
              <div style="margin-top:40px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.08);">
                <p style="font-size:14px;color:rgba(255,255,255,0.5);margin:0;">Train smart,</p>
                <p style="font-size:14px;font-weight:700;color:#fff;margin:4px 0 0;">Dean</p>
                <p style="font-size:12px;color:rgba(255,255,255,0.3);margin:2px 0 0;">Founder, irontri</p>
              </div>
            </div>
          </div>
        `
      })
    });
    console.log('Welcome email sent to:', email);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const name = session.customer_details?.name || '';
    await markUserPaid(email, session.subscription);
    await sendWelcomeEmail(email, name);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subId = event.data.object.id;
    await fetch(`${SUPABASE_URL}/rest/v1/plans?stripe_subscription_id=eq.${subId}`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ is_paid: false })
    });
    console.log('Subscription cancelled:', subId);
  }

  return res.status(200).json({ received: true });
}
