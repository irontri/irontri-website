import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aezfxagplaxlmovqbmfd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Most likely cause of "wrong API": the service key is missing in this environment.
  // Fail with a clear log + a human message instead of a cryptic createClient throw.
  if (!SUPABASE_SERVICE_KEY) {
    console.error('delete-account: SUPABASE_SERVICE_KEY is not set in this environment');
    return res.status(500).json({ error: 'Account deletion is temporarily unavailable. Please email coach@irontriapp.com and we will remove it for you.' });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    // Delete child data first — check every step so a failure isn't swallowed silently.
    for (const table of ['completions', 'plans', 'push_subscriptions']) {
      const { error } = await supabase.from(table).delete().eq('user_id', userId);
      if (error) { console.error(`delete-account: failed deleting from ${table}:`, error.message); throw error; }
    }

    const { error: userErr } = await supabase.from('users').delete().eq('id', userId);
    if (userErr) { console.error('delete-account: failed deleting users row:', userErr.message); throw userErr; }

    // Delete the auth user LAST. This call REQUIRES the service_role key (not the anon key).
    // If this is where it fails with "Invalid API key" / "User not allowed", the env var is the problem.
    const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
    if (authErr) { console.error('delete-account: auth.admin.deleteUser failed:', authErr.message); throw authErr; }

    return res.status(200).json({ success: true });
  } catch (e) {
    // Log the real error for you (visible in Vercel logs); return something actionable to the user.
    console.error('delete-account error:', e.message);
    return res.status(500).json({ error: 'We hit an error deleting your account. Please email coach@irontriapp.com and we will remove it manually.' });
  }
}
