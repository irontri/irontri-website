// api/delete-account.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aezfxagplaxlmovqbmfd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Delete user's plans and completions (cascades from auth.users if FK set, but explicit is safer)
    await supabase.from('completions').delete().eq('user_id', userId);
    await supabase.from('plans').delete().eq('user_id', userId);

    // Delete the auth user (requires service key)
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('delete-account error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
