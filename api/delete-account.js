import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aezfxagplaxlmovqbmfd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Most likely cause of the old "wrong API" error if this ever fires: service key missing here.
  if (!SUPABASE_SERVICE_KEY) {
    console.error('delete-account: SUPABASE_SERVICE_KEY is not set in this environment');
    return res.status(500).json({ error: 'Account deletion is temporarily unavailable. Please email coach@irontriapp.com and we will remove it for you.' });
  }

  // Identify the caller from their access token. NEVER trust a userId from the body —
  // that would let anyone delete anyone's account.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    // Validate the token and resolve the real user id from it.
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) {
      console.error('delete-account: token validation failed:', authErr?.message);
      return res.status(401).json({ error: 'Your session has expired. Please log in again and retry.' });
    }
    const userId = user.id;

    // Delete child data first — check every step so a failure is never swallowed silently.
    for (const table of ['completions', 'plans', 'push_subscriptions']) {
      const { error } = await admin.from(table).delete().eq('user_id', userId);
      if (error) { console.error(`delete-account: failed deleting from ${table}:`, error.message); throw error; }
    }

    const { error: userErr } = await admin.from('users').delete().eq('id', userId);
    if (userErr) { console.error('delete-account: failed deleting users row:', userErr.message); throw userErr; }

    // Delete the auth user last. Requires the service_role key.
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) { console.error('delete-account: auth.admin.deleteUser failed:', delErr.message); throw delErr; }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('delete-account error:', e.message);
    return res.status(500).json({ error: 'We hit an error deleting your account. Please email coach@irontriapp.com and we will remove it manually.' });
  }
}
