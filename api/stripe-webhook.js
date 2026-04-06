export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  let event;
  try {
    // Verify Stripe signature
    const { createHmac } = await import('crypto');
    const rawBody = JSON.stringify(req.body);
    const [, timestampPart, signaturePart] = sig.split(',').reduce((acc, part) => {
      const [key, val] = part.split('=');
      if (key === 't') acc[1] = val;
      if (key === 'v1') acc[2] = val;
      return acc;
    }, ['', '', '']);
    const expectedSig = createHmac('sha256', webhookSecret)
      .update(`${timestampPart}.${rawBody}`)
      .digest('hex');
    if (expectedSig !== signaturePart) {
      console.error('Webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }
    event = req.body;
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(400).json({ error: err.message });
  }

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };

  // Handle subscription created or payment succeeded
  if (event.type === 'checkout.session.completed' || 
      event.type === 'customer.subscription.created' ||
      event.type === 'invoice.payment_succeeded') {

    let customerEmail = null;
    let subscriptionId = null;

    if (event.type === 'checkout.session.completed') {
      customerEmail = event.data.object.customer_details?.email || event.data.object.customer_email;
      subscriptionId = event.data.object.subscription;
    } else if (event.type === 'customer.subscription.created') {
      subscriptionId = event.data.object.id;
      // Get customer email from Stripe customer ID
      const custId = event.data.object.customer;
      const custRes = await fetch(`https://api.stripe.com/v1/customers/${custId}`, {
        headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
      });
      const cust = await custRes.json();
      customerEmail = cust.email;
    } else if (event.type === 'invoice.payment_succeeded') {
      subscriptionId = event.data.object.subscription;
      customerEmail = event.data.object.customer_email;
    }

    if (customerEmail) {
      console.log(`Marking ${customerEmail} as paid, sub: ${subscriptionId}`);
      // Find user by email
      const userRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_user_id_by_email`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({ user_email: customerEmail })
      });

      // Update all plans for this user as paid
      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/plans?user_id=eq.(select id from auth.users where email=eq.${encodeURIComponent(customerEmail)})`,
        {
          method: 'PATCH',
          headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ 
            is_paid: true, 
            stripe_subscription_id: subscriptionId 
          })
        }
      );

      // Better approach - use service key to query auth.users
      const emailRes = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(customerEmail)}`,
        { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } }
      );
      const emailData = await emailRes.json();
      const userId = emailData?.users?.[0]?.id;

      if (userId) {
        const patchRes = await fetch(
          `${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}`,
          {
            method: 'PATCH',
            headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ 
              is_paid: true, 
              stripe_subscription_id: subscriptionId || null
            })
          }
        );
        console.log('Updated plans, status:', patchRes.status);
      } else {
        console.error('Could not find user for email:', customerEmail);
      }
    }
  }

  // Handle subscription cancelled
  if (event.type === 'customer.subscription.deleted') {
    const subscriptionId = event.data.object.id;
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?stripe_subscription_id=eq.${subscriptionId}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ is_paid: false })
      }
    );
    console.log('Cancelled subscription, status:', patchRes.status);
  }

  return res.status(200).json({ received: true });
}
