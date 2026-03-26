// irontri shared nav auth — include on every page
(async () => {
  try {
    // Wait for Supabase to restore session from storage
    await new Promise(r => setTimeout(r, 300));
    
    const sb = window.supabase.createClient(
      'https://aezfxagplaxlmovqbmfd.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFlemZ4YWdwbGF4bG1vdnFibWZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NjY2MzQsImV4cCI6MjA5MDA0MjYzNH0.jPyE36x0jEoX3qsCFBMpMewwmbUI0gRkAtj4EREpMSU'
    );
    const { data: { session } } = await sb.auth.getSession();
    const navRight = document.getElementById('nav-auth');
    if (!navRight) return;

    if (session) {
      const name = session.user.user_metadata?.full_name || session.user.email.split('@')[0];
      navRight.innerHTML = `
        <a href="/dashboard.html" style="color:rgba(255,255,255,0.85);text-decoration:none;font-size:14px;margin-right:4px;">Dashboard</a>
        <a href="/profile.html" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none;">👤 ${name}</a>`;
    }
    // If not logged in — keep the default Log in / Sign up buttons
  } catch(e) {}
})();
