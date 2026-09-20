function toggleNav() {
  const links = document.getElementById('navLinks');
  const btn = document.getElementById('navHamburger');
  if (!links || !btn) return;
  const open = links.classList.toggle('open');
  btn.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
}
