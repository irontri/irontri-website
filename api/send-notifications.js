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

    const doneToday = dates[0] === today;
    if (doneToday) return { streak: 0, atRisk: false };

    let streak = 0;
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

    return { streak, atRisk: streak >= 2 };
  } catch(e) {
    return { streak: 0, atRisk: false };
  }
}

// Get weekly summary stats (runs on Mondays)
function getWeeklySummary(completions) {
  try {
    if (!completions || completions.length === 0) return null;
    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek - 7);
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

// Build notification content for a user
function buildNotificationContent(planData, userCompletions, isMonday) {
  const session = getTodaySession(planData);
  const { streak, atRisk } = getStreakInfo(userCompletions);
  let title, body;

  if (isMonday) {
    const lastWeekSessions = getWeeklySummary(userCompletions);
    if (lastWeekSessions !== null && lastWeekSessions > 0) {
      title = `Last week: ${lastWeekSessions} session${lastWeekSessions !== 1 ? 's' : ''} completed 💪`;
      body = 'New week starts today — let\'s go! Open your plan 🏊🚴🏃';
    } else if (lastWeekSessions === 0) {
      title = 'New week, fresh start 🏁';
      body = 'Last week is done — this week is your chance. Open your plan now.';
    } else {
      title = session ? `Today: ${session.name}` : 'irontri — Training Reminder';
      body = session
        ? `${getEmoji(session.type)} ${session.type}${fmtDuration(session.duration)} — tap to open your session`
        : '🏊🚴🏃 Check today\'s session on your dashboard';
    }
  } else if (atRisk && session) {
    title = `🔥 ${streak} day streak at risk!`;
    body = `Don't break it — ${session.name} is waiting for you today`;
  } else if (session) {
    title = `Today: ${session.name}`;
    body = `${getEmoji(session.type)} ${session.type}${fmtDuration(session.duration)} — tap to open your session`;
  } else {
    title = 'irontri — Training Reminder';
    body = '🏊🚴🏃 Check today\'s session on your dashboard';
  }

  return { title, body };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (req.method === 'GET' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const todayDayOfWeek = new Date().getDay();
  const isMonday = todayDayOfWeek === 1;

  try {
    // Fetch all push subscriptions (web)
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

    // Fetch all app users with expo push tokens
    const appUsersRes = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/users?select=id,expo_push_token&expo_push_token=not.is.null',
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
        }
      }
    );
    const appUsers = await appUsersRes.json();

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

    // Fetch completions for all users
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
    const completionsMap = {};
    for (const c of (allCompletions || [])) {
      if (!completionsMap[c.user_id]) completionsMap[c.user_id] = [];
      completionsMap[c.user_id].push(c);
    }

    let sent = 0, failed = 0;
    const expiredUsers = [];

    // ── WEB PUSH (existing) ──────────────────────────────────────
    if (subscriptions?.length) {
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
          const { title, body } = buildNotificationContent(planData, userCompletions, isMonday);
          const payload = JSON.stringify({ title, body, url: '/dashboard.html' });
          await webpush.sendNotification(row.subscription, payload);
          sent++;
        } catch(e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            expiredUsers.push(row.user_id);
          }
          failed++;
        }
      }

      // Remove expired web subscriptions
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

    // ── EXPO PUSH (app) ──────────────────────────────────────────
    if (appUsers?.length) {
      const expoMessages = [];
      const invalidTokenUsers = [];

      for (const user of appUsers) {
        try {
          let planData = null;
          if (planMap[user.id]) {
            try {
              let txt = planMap[user.id];
              txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
              planData = JSON.parse(txt);
            } catch(e) {}
          }

          const userCompletions = completionsMap[user.id] || [];
          const { title, body } = buildNotificationContent(planData, userCompletions, isMonday);

          expoMessages.push({
            to: user.expo_push_token,
            sound: 'default',
            title,
            body,
            data: { screen: 'Dashboard' },
            _userId: user.id, // track for cleanup
          });
        } catch(e) {
          failed++;
        }
      }

      // Send to Expo push API in chunks of 100
      const chunks = [];
      for (let i = 0; i < expoMessages.length; i += 100) {
        chunks.push(expoMessages.slice(i, i + 100));
      }

      for (const chunk of chunks) {
        try {
          const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Accept-Encoding': 'gzip, deflate',
            },
            body: JSON.stringify(chunk.map(({ _userId, ...msg }) => msg)),
          });
          const expoData = await expoRes.json();

          // Check for invalid tokens and clean up
          if (expoData?.data) {
            expoData.data.forEach((receipt, i) => {
              if (receipt.status === 'ok') {
                sent++;
              } else if (receipt.details?.error === 'DeviceNotRegistered') {
                invalidTokenUsers.push(chunk[i]._userId);
                failed++;
              } else {
                failed++;
              }
            });
          }
        } catch(e) {
          console.error('Expo push error:', e);
          failed += chunk.length;
        }
      }

      // Clear invalid expo tokens
      for (const uid of invalidTokenUsers) {
        await fetch(
          process.env.SUPABASE_URL + '/rest/v1/users?id=eq.' + uid,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': process.env.SUPABASE_ANON_KEY,
              'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
            },
            body: JSON.stringify({ expo_push_token: null })
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
