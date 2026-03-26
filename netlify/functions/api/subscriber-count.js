export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch('https://connect.mailerlite.com/api/groups/182918184673740575/subscribers?limit=1', {
      headers: {
        'Authorization': `Bearer ${process.env.MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    const count = data?.meta?.total || 0;

    return res.status(200).json({ count });
  } catch(e) {
    return res.status(200).json({ count: 0 });
  }
}
