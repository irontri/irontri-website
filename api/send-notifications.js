import webpush from 'web-push';

export const config = { maxDuration: 60 };

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Work out today's session for a user's plan
function getTodaySession(planData) {
  try {
    if (!planData?.weeks || !planData?.startDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(planData.startDate + 'T00:00:00');
    start.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today - start) / 86400000);
    if (diffDays < 0) return null;
    const weekIdx = Math.floor(diffDays / 7);
    const dayIdx = diffDays % 7;
    if (weekIdx >= planData.weeks.length) return null;
    const week = planData.weeks[weekIdx];
    const day = week?.days?.[dayIdx];
    if (!day || day.type === 'Rest') return null;
    return { name: day.name || day.type + ' Session', type: day.type, duration: day.duration };
  } catch(e) {
    return null;
  }
}

function getEmoji(type) {
  const map = { Swim: '🏊', Bike: '🚴', Run: '🏃', Brick: '🔥', Strength: '💪' };
  return map[type] || '🏋️';
}

function fmtDuration(mins) {
  if (!mins) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return ` · ${h}h${m > 0 ? m + 'm' : ''}`;
  return ` · ${m}min`;
}

export default async function handler(req, res) {
  // Allow manual trigger via POST, or cron via GET
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Secure cron calls - Vercel sets this header automatically
  const authHeader = req.headers['authorization'];
  if (req.method === 'GET' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Fetch all push subscriptions with latest plan for each user
    const subsRes = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/push_subscriptions?select=user_id,subscription',
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
        }
      }
    );
    const subscriptions = await subsRes.json();
    if (!subscriptions?.length) return res.status(200).json({ sent: 0, message: 'No subscriptions' });

    // Fetch latest plan for each user
    const userIds = subscriptions.map(s => s.user_id);
    const plansRes = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/plans?select=user_id,plan_data&order=created_at.desc',
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
        }
      }
    );
    const allPlans = await plansRes.json();

    // Build map: user_id -> latest plan_data
    const planMap = {};
    for (const plan of allPlans) {
      if (!planMap[plan.user_id]) planMap[plan.user_id] = plan.plan_data;
    }

    let sent = 0;
    let failed = 0;
    const expiredUsers = [];

    for (const row of subscriptions) {
      try {
        let planData = null;
        if (planMap[row.user_id]) {
          try {
            let txt = planMap[row.user_id];
            txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
            planData = JSON.parse(txt);
          } catch(e) {}
        }

        const session = getTodaySession(planData);
        let title, body;

        if (session) {
          const emoji = getEmoji(session.type);
          title = `Today: ${session.name}`;
          body = `${emoji} ${session.type}${fmtDuration(session.duration)} — tap to open your session`;
        } else {
          title = 'irontri — Training Reminder';
          body = '🏊🚴🏃 Check today\'s session on your dashboard';
        }

        const payload = JSON.stringify({ title, body, url: '/dashboard.html' });
        await webpush.sendNotification(row.subscription, payload);
        sent++;
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Subscription expired — clean up
          expiredUsers.push(row.user_id);
        }
        failed++;
      }
    }

    // Remove expired subscriptions
    if (expiredUsers.length > 0) {
      for (const uid of expiredUsers) {
        await fetch(
          process.env.SUPABASE_URL + '/rest/v1/push_subscriptions?user_id=eq.' + uid,
          {
            method: 'DELETE',
            headers: {
              'apikey': process.env.SUPABASE_ANON_KEY,
              'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
            }
          }
        );
      }
    }

    return res.status(200).json({ sent, failed, expired: expiredUsers.length });
  } catch(e) {
    console.error('send-notifications error:', e);
    return res.status(500).json({ error: e.message });
  }
}
