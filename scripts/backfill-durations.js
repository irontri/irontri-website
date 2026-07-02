// One-off backfill: sync session `duration` to match the actual warmup/mainset/cooldown
// text on every existing plan in Supabase. Fixes stale sessions generated before the
// duration-sync logic existed in generate-plan.js / build-remaining.js.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node backfill-durations.js
//
// Add --dry-run to only log what would change, without writing anything.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  process.exit(1);
}

// Same logic as fixSessionDurations() in build-remaining.js / generate-plan.js —
// kept identical on purpose so behaviour matches what new plans already get.
function extractMins(text) {
  if (!text) return 0;
  let total = 0;
  // "1h 30min", "1.5h", "1h", "1 hour"
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*h(?:our)?s?(?:\s*(\d+)\s*min(?:ute)?s?)?/i);
  if (hourMatch) {
    total += parseFloat(hourMatch[1]) * 60;
    if (hourMatch[2]) total += parseInt(hourMatch[2]);
    return Math.round(total);
  }
  const minMatches = [...text.matchAll(/(\d+)\s*min(?:ute)?s?/gi)];
  if (minMatches.length > 0) {
    if (minMatches.length === 1) return parseInt(minMatches[0][1]);
    const singleEffortMatch = text.match(/(\d+)\s*min(?:ute)?s?\s+(?:continuous|steady|easy|hard|at|of|run|ride|swim|jog|walk|spin)/i);
    if (singleEffortMatch) return parseInt(singleEffortMatch[1]);
    return Math.max(...minMatches.map(m => parseInt(m[1])));
  }
  return 0;
}

function fixSessionDurations(weeks) {
  let changedCount = 0;
  const changes = [];
  (weeks || []).forEach(wk => {
    if (!wk.days) return;
    wk.days.forEach(d => {
      if (d.type === 'Rest' || d.type === 'Race' || !d.duration) return;

      const warmupMins = extractMins(d.warmup || '');
      const mainsetMins = extractMins(d.mainset || '');
      const cooldownMins = extractMins(d.cooldown || '');
      const textTotal = warmupMins + mainsetMins + cooldownMins;

      if (textTotal < 5) return; // Can't parse text, leave alone

      const currentDuration = parseFloat(d.duration) || 0;
      const diff = Math.abs(currentDuration - textTotal);

      if (diff > 5) {
        changes.push({
          week: wk.weekNumber, day: d.day, name: d.name,
          from: currentDuration, to: textTotal
        });
        d.duration = textTotal;
        changedCount++;
      }
    });
  });
  return { changedCount, changes };
}

async function fetchAllPlans() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/plans?select=id,user_id,plan_data`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch plans: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function updatePlan(id, planDataStr) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/plans?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ plan_data: planDataStr })
  });
  if (!res.ok) {
    throw new Error(`Failed to update plan ${id}: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  console.log(DRY_RUN ? 'Running in DRY-RUN mode — no writes will happen.\n' : 'Running LIVE — plans will be updated.\n');

  const plans = await fetchAllPlans();
  console.log(`Fetched ${plans.length} plans.\n`);

  let plansTouched = 0;
  let sessionsTouched = 0;

  for (const plan of plans) {
    if (!plan.plan_data) continue;

    let pd;
    try {
      pd = JSON.parse(plan.plan_data);
    } catch (e) {
      console.log(`[skip] plan ${plan.id} — invalid JSON: ${e.message}`);
      continue;
    }

    if (!pd.weeks || !Array.isArray(pd.weeks)) continue;

    const { changedCount, changes } = fixSessionDurations(pd.weeks);

    if (changedCount > 0) {
      plansTouched++;
      sessionsTouched += changedCount;
      console.log(`Plan ${plan.id} (user ${plan.user_id}) — ${changedCount} session(s):`);
      changes.forEach(c => {
        console.log(`  Week ${c.week} ${c.day} "${c.name}": ${c.from}min -> ${c.to}min`);
      });

      if (!DRY_RUN) {
        await updatePlan(plan.id, JSON.stringify(pd));
        console.log(`  -> saved`);
      }
      console.log('');
    }
  }

  console.log(`Done. ${plansTouched} plan(s) touched, ${sessionsTouched} session(s) fixed.`);
  if (DRY_RUN) console.log('This was a dry run — re-run without --dry-run to save changes.');
}

main().catch(e => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
