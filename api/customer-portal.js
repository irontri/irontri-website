const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { userId } = req.body;

    // Get stripe_customer_id from plans table
    const { data: plan, error } = await supabase
      .from('plans')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .eq('is_paid', true)
      .single();

    if (error || !plan?.stripe_customer_id) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: plan.stripe_customer_id,
      return_url: 'https://www.irontriapp.com/dashboard.html',
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: err.message });
  }
};
