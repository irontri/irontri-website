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

// Check if user has a streak and if it's at risk today
function getStreakInfo(completions) {
  try {
    if (!completions || completions.length === 0) return { streak: 0, atRisk: false };
    const dates = [...new Set(completions.map(c => c.created_at.slice(0, 10)))].sort().reverse();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Has user already completed something today?
    const doneToday = dates[0] === today;
    if (doneToday) return { streak: 0, atRisk: false }; // already done, no reminder needed

    // Calculate streak from yesterday
    let streak = 0;
    const startFrom = dates[0] === yesterday ? dates : [];
    if (dates[0] === yesterday) {
      streak = 1;
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]);
        const curr = new Date(dates[i]);
        const diff = Math.round((prev - curr) / 86400000);
        if (diff === 1) streak++;
        else break;
      }
    }

    return { streak, atRisk: streak >= 2 }; // only warn if streak is worth saving (2+ days)
  } catch(e) {
    return { streak: 0, atRisk: false };
  }
}

// Get weekly summary stats (runs on Mondays)
function getWeeklySummary(completions) {
  try {
    if (!completions || completions.length === 0) return null;
    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7; // Mon=0
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek - 7); // last week start
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    const lastWeekSessions = completions.filter(c => {
      const d = new Date(c.created_at);
      return d >= weekStart && d < weekEnd;
    }).length;

    return lastWeekSessions;
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
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (req.method === 'GET' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // What day is it? Monday = weekly summary day
  const todayDayOfWeek = new Date().getDay(); // 0=Sun, 1=Mon
  const isMonday = todayDayOfWeek === 1;

  try {
    // Fetch all push subscriptions
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
    const planMap = {};
    for (const plan of allPlans) {
      if (!planMap[plan.user_id]) planMap[plan.user_id] = plan.plan_data;
    }

    // Fetch completions for all users (for streak and weekly summary)
    const completionsRes = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/completions?select=user_id,created_at&order=created_at.desc',
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
        }
      }
    );
    const allCompletions = await completionsRes.json();

    // Build map: user_id -> completions array
    const completionsMap = {};
    for (const c of (allCompletions || [])) {
      if (!completionsMap[c.user_id]) completionsMap[c.user_id] = [];
      completionsMap[c.user_id].push(c);
    }

    let sent = 0, failed = 0;
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

        const userCompletions = completionsMap[row.user_id] || [];
        const session = getTodaySession(planData);
        const { streak, atRisk } = getStreakInfo(userCompletions);

        let title, body, url = '/dashboard.html';

        // Monday = weekly summary takes priority
        if (isMonday) {
          const lastWeekSessions = getWeeklySummary(userCompletions);
          if (lastWeekSessions !== null && lastWeekSessions > 0) {
            title = `Last week: ${lastWeekSessions} session${lastWeekSessions !== 1 ? 's' : ''} completed 💪`;
            body = 'New week starts today — let\'s go! Open your plan 🏊🚴🏃';
          } else if (lastWeekSessions === 0) {
            title = 'New week, fresh start 🏁';
            body = 'Last week is done — this week is your chance. Open your plan now.';
          } else {
            // Fall through to daily session reminder
            title = session ? `Today: ${session.name}` : 'irontri — Training Reminder';
            body = session
              ? `${getEmoji(session.type)} ${session.type}${fmtDuration(session.duration)} — tap to open your session`
              : '🏊🚴🏃 Check today\'s session on your dashboard';
          }
        } else if (atRisk && session) {
          // Streak at risk — has a session today but hasn't done it yet
          title = `🔥 ${streak} day streak at risk!`;
          body = `Don't break it — ${session.name} is waiting for you today`;
        } else if (session) {
          // Standard daily session reminder
          title = `Today: ${session.name}`;
          body = `${getEmoji(session.type)} ${session.type}${fmtDuration(session.duration)} — tap to open your session`;
        } else {
          title = 'irontri — Training Reminder';
          body = '🏊🚴🏃 Check today\'s session on your dashboard';
        }

        const payload = JSON.stringify({ title, body, url });
        await webpush.sendNotification(row.subscription, payload);
        sent++;
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          expiredUsers.push(row.user_id);
        }
        failed++;
      }
    }

    // Remove expired subscriptions
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

    return res.status(200).json({ sent, failed, expired: expiredUsers.length });
  } catch(e) {
    console.error('send-notifications error:', e);
    return res.status(500).json({ error: e.message });
  }
}
