// irontri shared nav auth
document.addEventListener('DOMContentLoaded', () => {
  const navRight = document.getElementById('nav-auth');
  if (!navRight) return;

  // Check localStorage for saved user name
  const savedName = localStorage.getItem('irontri_user_name');
  if (savedName) {
    navRight.innerHTML = `
      <a href="/dashboard.html" style="color:rgba(255,255,255,0.85);text-decoration:none;font-size:14px;margin-right:8px;">Dashboard</a>
      <a href="/profile.html" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none;">👤 ${savedName}</a>`;
  }
});
