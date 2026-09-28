function toggleNav() {
  const links = document.getElementById('navLinks');
  const btn = document.getElementById('navHamburger');
  if (!links || !btn) return;
  const open = links.classList.toggle('open');
  btn.classList.toggle('open', open);
  // Etat expose aux technologies d'assistance (sinon le bouton reste muet)
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
}
document.querySelectorAll('#navLinks a').forEach(a => {
  a.addEventListener('click', () => {
    document.getElementById('navLinks').classList.remove('open');
    document.getElementById('navHamburger').classList.remove('open');
  });
});

fetch('/api/admin/changelog')
  .then(r => r.json())
  .then(d => {
    const list = document.getElementById('list');
    if (!d.versions || !d.versions.length) {
      list.innerHTML = '<p style="color: var(--muted); text-align:center; padding:40px 0;">No published versions yet.</p>';
      return;
    }
    list.innerHTML = d.versions.map((v, i) => `
      <div class="card reveal" style="margin-bottom: 14px; animation-delay: ${i * 0.06}s;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <span style="font-size: 19px; font-weight: 700; background: linear-gradient(135deg, #d8b4fe, #c084fc); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;">v${v.version}</span>
            ${v.gameName ? `<span class="badge-pill" style="background:#8b5cf622; color:#c084fc; border:1px solid #8b5cf655; font-size:11px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px; margin-right:4px;"><rect x="2" y="6" width="20" height="12" rx="2"></rect><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line></svg>${v.gameName.replace(/</g, '&lt;')}</span>` : '<span class="badge-pill" style="background:#ffffff10; color:#a1a1aa; font-size:11px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px; margin-right:4px;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>All Games</span>'}
          </div>
          <span style="color: var(--muted); font-size: 13px;">${new Date(v.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
        </div>
        <p style="margin-top: 10px; line-height: 1.7; color: var(--muted);">${(v.note || '').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>
      </div>
    `).join('');

    // Trigger reveal animation
    list.querySelectorAll('.reveal').forEach(el => {
      const io = new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }});
      }, { threshold: 0.12 });
      io.observe(el);
    });
  })
  .catch(() => document.getElementById('list').innerHTML = '<p style="color: var(--muted); text-align:center;">Failed to load.</p>');
