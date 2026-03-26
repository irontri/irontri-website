// irontri shared nav auth
(async () => {
  try {
    const sb = window.supabase.createClient(
      'https://aezfxagplaxlmovqbmfd.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFlemZ4YWdwbGF4bG1vdnFibWZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NjY2MzQsImV4cCI6MjA5MDA0MjYzNH0.jPyE36x0jEoX3qsCFBMpMewwmbUI0gRkAtj4EREpMSU'
    );

    function updateNav(session) {
      const navRight = document.getElementById('nav-auth');
      if (!navRight) return;
      if (session) {
        const name = session.user.user_metadata?.full_name || session.user.email.split('@')[0];
        navRight.innerHTML = `
          <a href="/dashboard.html" style="color:rgba(255,255,255,0.85);text-decoration:none;font-size:14px;margin-right:4px;">Dashboard</a>
          <a href="/profile.html" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none;">👤 ${name}</a>`;
      }
    }

    // Check immediately
    const { data: { session } } = await sb.auth.getSession();
    updateNav(session);

    // Also listen for auth changes
    sb.auth.onAuthStateChange((_event, session) => {
      updateNav(session);
    });

  } catch(e) {}
})();
