export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'No email provided' });

  try {
    // Find Stripe customer by email
    const searchRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY } }
    );
    const searchData = await searchRes.json();
    const customerId = searchData?.data?.[0]?.id;
    if (!customerId) return res.status(404).json({ error: 'No Stripe customer found' });

    // Create portal session
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        customer: customerId,
        return_url: 'https://www.irontriapp.com/profile.html'
      })
    });
    const portalData = await portalRes.json();
    if (!portalData.url) return res.status(500).json({ error: 'Could not create portal session' });

    return res.status(200).json({ url: portalData.url });
  } catch (e) {
    console.error('Portal error:', e);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
