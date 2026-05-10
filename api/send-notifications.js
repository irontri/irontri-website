import webpush from 'web-push';

export const config = { maxDuration: 60 };

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Check if it's currently 7am in a given timezone
function isSevenAM(timezone) {
  try {
    if (!timezone) return false;
    const now = new Date();
    const hour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false
    }).format(now), 10);
    return hour === 7;
  } catch(e) {
    return false;
  }
}

// Get today's session for a user's plan (in their local timezone)
function getTodaySession(planData, timezone) {
  try {
    if (!planData?.weeks || !planData?.startDate) return null;

    // Get today's date in user's local timezone
    const now = new Date();
    const localDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);

    const today = new Date(localDateStr + 'T00:00:00');
    const start = new Date(planData.startDate + 'T00:00:00');
    const diffDays = Math.round((today - start) / 86400000);
    if (diffDays < 0) return null;
    const weekIdx = Math.floor(diffDays / 7);
    if (weekIdx >= planData.weeks.length) return null;
    const week = planData.weeks[weekIdx];
    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const todayName = DAY_NAMES[today.getDay()];
    const day = week?.days?.find(d => d.day === todayName && d.type !== 'Rest');
    if (!day) return null;
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

// Check if it's Monday in a user's local timezone
function isLocalMonday(timezone) {
  try {
    const now = new Date();
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'long'
    }).format(now);
    return day === 'Monday';
  } catch(e) {
    return false;
  }
}

// Build notification content for a user
function buildNotificationContent(planData, userCompletions, timezone) {
  const session = getTodaySession(planData, timezone);
  const { streak, atRisk } = getStreakInfo(userCompletions);
  const isMonday = isLocalMonday(timezone);
  let title, body;

  if (isMonday) {
    const lastWeekSessions = getWeeklySummary(userCompletions);
    if (lastWeekSessions !== null && lastWeekSessions > 0) {
      title = `Last week: ${lastWeekSessions} session${lastWeekSessions !== 1 ? 's' : ''} completed 💪`;
      body = session
        ? `New week starts today — first up: ${session.name} ${getEmoji(session.type)}${fmtDuration(session.duration)}`
        : 'New week starts today — let\'s go! Open your plan 🏊🚴🏃';
    } else if (lastWeekSessions === 0) {
      title = 'New week, fresh start 🏁';
      body = session
        ? `Last week is done — kick off with ${session.name} today`
        : 'Last week is done — this week is your chance. Open your plan now.';
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
    title = 'irontri — Rest day 😴';
    body = 'No session today — recover well. You\'ve earned it.';
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

  try {
    // Fetch all push subscriptions (web) with timezone
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

    // Fetch all app users with expo push tokens + timezone
    const appUsersRes = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/users?select=id,expo_push_token,timezone&expo_push_token=not.is.null',
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
        }
      }
    );
    const appUsers = await appUsersRes.json();

    // Fetch timezone for web push users
    const webUserIds = (subscriptions || []).map(s => s.user_id).filter(Boolean);
    let webUserTimezones = {};
    if (webUserIds.length > 0) {
      const tzRes = await fetch(
        process.env.SUPABASE_URL + '/rest/v1/users?select=id,timezone&id=in.(' + webUserIds.join(',') + ')',
        {
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
          }
        }
      );
      const tzData = await tzRes.json();
      for (const u of (tzData || [])) webUserTimezones[u.id] = u.timezone;
    }

    // Fetch all plans
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
    const now = new Date();
    for (const plan of allPlans) {
      if (planMap[plan.user_id]) continue;
      try {
        let txt = plan.plan_data || '';
        txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
        const pd = JSON.parse(txt);
        const startDate = pd.startDate ? new Date(pd.startDate + 'T00:00:00') : null;
        const raceDate = pd.raceDate ? new Date(pd.raceDate + 'T00:00:00') : null;
        const isActive = startDate && startDate <= now && (!raceDate || raceDate >= now);
        if (isActive) planMap[plan.user_id] = plan.plan_data;
      } catch(e) {}
    }
    for (const plan of allPlans) {
      if (!planMap[plan.user_id]) planMap[plan.user_id] = plan.plan_data;
    }

    // Fetch completions
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

    let sent = 0, failed = 0, skipped = 0;
    const expiredUsers = [];

    // ── WEB PUSH ──────────────────────────────────────────────────
    if (subscriptions?.length) {
      for (const row of subscriptions) {
        try {
          const timezone = webUserTimezones[row.user_id] || 'Australia/Perth';
          // Only send if it's 7am in user's local timezone
          if (!isSevenAM(timezone)) { skipped++; continue; }

          let planData = null;
          if (planMap[row.user_id]) {
            try {
              let txt = planMap[row.user_id];
              txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
              planData = JSON.parse(txt);
            } catch(e) {}
          }

          const userCompletions = completionsMap[row.user_id] || [];
          const { title, body } = buildNotificationContent(planData, userCompletions, timezone);
          const payload = JSON.stringify({ title, body, url: '/dashboard.html' });
          await webpush.sendNotification(row.subscription, payload);
          sent++;
        } catch(e) {
          if (e.statusCode === 410 || e.statusCode === 404) expiredUsers.push(row.user_id);
          failed++;
        }
      }

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

    // ── EXPO PUSH (app) ───────────────────────────────────────────
    if (appUsers?.length) {
      const expoMessages = [];
      const invalidTokenUsers = [];

      for (const user of appUsers) {
        try {
          const timezone = user.timezone || 'Australia/Perth';
          // Only send if it's 7am in user's local timezone
          if (!isSevenAM(timezone)) { skipped++; continue; }

          let planData = null;
          if (planMap[user.id]) {
            try {
              let txt = planMap[user.id];
              txt = txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
              planData = JSON.parse(txt);
            } catch(e) {}
          }

          const userCompletions = completionsMap[user.id] || [];
          const { title, body } = buildNotificationContent(planData, userCompletions, timezone);

          expoMessages.push({
            to: user.expo_push_token,
            sound: 'default',
            title,
            body,
            data: { screen: 'Dashboard' },
            _userId: user.id,
          });
        } catch(e) {
          failed++;
        }
      }

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

          if (expoData?.data) {
            expoData.data.forEach((receipt, i) => {
              if (receipt.status === 'ok') sent++;
              else if (receipt.details?.error === 'DeviceNotRegistered') {
                invalidTokenUsers.push(chunk[i]._userId);
                failed++;
              } else failed++;
            });
          }
        } catch(e) {
          console.error('Expo push error:', e);
          failed += chunk.length;
        }
      }

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

    return res.status(200).json({ sent, failed, skipped, expired: expiredUsers.length });
  } catch(e) {
    console.error('send-notifications error:', e);
    return res.status(500).json({ error: e.message });
  }
}
