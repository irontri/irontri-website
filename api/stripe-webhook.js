export const config = { maxDuration: 60, api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  // Read raw body for signature verification
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Verify Stripe signature
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const { createHmac } = await import('crypto');
    const parts = sig.split(',');
    let timestamp = '';
    let signature = '';
    for (const part of parts) {
      const [key, val] = part.split('=');
      if (key === 't') timestamp = val;
      if (key === 'v1') signature = val;
    }
    const payload = `${timestamp}.${rawBody}`;
    const expected = createHmac('sha256', webhookSecret).update(payload).digest('hex');
    if (expected !== signature) {
      console.error('Signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Webhook verification error:', err.message);
    return res.status(400).json({ error: err.message });
  }

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };

  console.log('Stripe event received:', event.type);

  async function markUserPaid(email, subscriptionId) {
    if (!email) return console.error('No email provided');
    console.log('Marking paid:', email, subscriptionId);
    const userRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } }
    );
    const userData = await userRes.json();
    const userId = userData?.users?.[0]?.id;
    if (!userId) return console.error('No user found for email:', email);
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ is_paid: true, stripe_subscription_id: subscriptionId || null })
      }
    );
    console.log('Plan updated, status:', patchRes.status);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    await markUserPaid(email, session.subscription);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subId = event.data.object.id;
    await fetch(
      `${SUPABASE_URL}/rest/v1/plans?stripe_subscription_id=eq.${subId}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ is_paid: false })
      }
    );
    console.log('Subscription cancelled:', subId);
  }

  return res.status(200).json({ received: true });
}
