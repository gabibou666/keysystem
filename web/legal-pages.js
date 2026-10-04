'use strict';
(() => {
  const select = document.querySelector('[data-legal-language]');
  const messages = {
    en: { language:'Language', dashboard:'Dashboard', home:'Home', hub:'Trust & transparency', updated:'Last updated October 4, 2026.', placeholder:'To be completed by the publisher', contact:'Privacy contact to be completed by the publisher' },
    fr: { language:'Langue', dashboard:'Dashboard', home:'Accueil', hub:'Confiance & transparence', updated:'Dernière mise à jour le 4 octobre 2026.', placeholder:'À renseigner par l’éditeur', contact:'Contact confidentialité à renseigner par l’éditeur' },
  };
  let config = {};
  let language = 'en';
  try { const saved = localStorage.getItem('audit-hub-language'); language = ['en','fr'].includes(saved) ? saved : (navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'; }
  catch { language = (navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'; }
  const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
  function identity() {
    document.querySelectorAll('[data-legal-value]').forEach(node => {
      const value = config[node.dataset.legalValue];
      const valid = typeof value === 'string' && value.trim() && (node.dataset.legalValue !== 'legalEmail' || validEmail(value));
      node.textContent = valid ? value : messages[node.closest('[data-legal-locale]')?.dataset.legalLocale || language].placeholder;
      node.classList.toggle('legal-placeholder', !valid);
    });
    document.querySelectorAll('[data-legal-contact]').forEach(node => {
      const locale = node.closest('[data-legal-locale]')?.dataset.legalLocale || language;
      const email = validEmail(config.legalEmail) ? config.legalEmail : validEmail(config.supportEmail) ? config.supportEmail : '';
      node.replaceChildren();
      if (email) { const link = document.createElement('a'); link.href = 'mailto:' + email; link.textContent = email; node.append(link); node.classList.remove('legal-placeholder'); }
      else { node.textContent = messages[locale].contact; node.classList.add('legal-placeholder'); }
    });
  }
  function apply(next, save = false) {
    if (!messages[next]) return;
    language = next;
    document.documentElement.lang = next;
    if (select) { select.value = next; select.setAttribute('aria-label', messages[next].language); }
    document.querySelectorAll('[data-legal-locale]').forEach(node => { node.hidden = node.dataset.legalLocale !== next; });
    document.querySelectorAll('[data-legal-ui]').forEach(node => { const value = messages[next][node.dataset.legalUi]; if (value) node.textContent = value; });
    const visible = document.querySelector('[data-legal-locale="' + next + '"]');
    if (visible?.dataset.title) document.title = visible.dataset.title + ' — AUDIT HUB';
    if (save) {
      try { localStorage.setItem('audit-hub-language', next); } catch { /* Reading policies never depends on storage. */ }
      document.dispatchEvent(new CustomEvent('audit-hub:language', { detail: { language: next } }));
    }
    identity();
  }
  select?.addEventListener('change', () => apply(select.value, true));
  document.addEventListener('audit-hub:language', event => apply(event.detail?.language));
  window.addEventListener('storage', event => { if (event.key === 'audit-hub-language' && messages[event.newValue]) apply(event.newValue); });
  document.querySelectorAll('[data-legal-cookie-manage]').forEach(button => button.addEventListener('click', () => window.AuditHubConsent?.openPreferences()));
  apply(language);
  fetch('/api/site/config', { credentials:'same-origin', signal:AbortSignal.timeout(5000) }).then(response => response.ok ? response.json() : null).then(value => { if (value) { config = value; identity(); } }).catch(() => {});
})();
