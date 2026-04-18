import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { userId, email, planId } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      customer_email: email,
      client_reference_id: userId,
      success_url: `https://irontriapp.com/plan.html?load=${planId}&payment=success`,
      cancel_url: `https://irontriapp.com/plan.html?load=${planId}&payment=cancelled`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}
