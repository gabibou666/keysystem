'use strict';
(() => {
  const footer = document.querySelector('[data-site-footer]');
  if (!footer) return;
  const credit = document.createElement('p');
  credit.className = 'software-credit';
  credit.append(document.createTextNode('Based on Prometheus by Elias Oelschner, '));
  const upstream = document.createElement('a');
  upstream.href = 'https://github.com/prometheus-lua/Prometheus';
  upstream.textContent = upstream.href;
  upstream.target = '_blank';
  upstream.rel = 'noopener noreferrer';
  credit.append(upstream);
  footer.append(credit);
  const labels = {
    en: { tagline: 'Your scripts. Your rules.', product: 'Product', docs: 'Documentation', scripts: 'Published scripts', status: 'Status', legal: 'Legal', privacy: 'Privacy', terms: 'Terms of use', cookies: 'Cookie policy', notice: 'Legal notice', manage: 'Manage my cookies', support: 'Support', discord: 'Discord support', email: 'Email support' },
    fr: { tagline: 'Your scripts. Your rules.', product: 'Produit', docs: 'Documentation', scripts: 'Scripts publiés', status: 'Statut', legal: 'Légal', privacy: 'Confidentialité', terms: 'Conditions d’utilisation', cookies: 'Politique de cookies', notice: 'Mentions légales', manage: 'Gérer mes cookies', support: 'Support', discord: 'Support Discord', email: 'Support par email' },
  };
  let siteSettings;
  function displayAnnouncement(language = preferredLanguage()) {
    const settings = siteSettings;
    let banner = document.getElementById('siteAnnouncement');
    if (!settings || !settings.announcement && !settings.maintenance) { banner?.remove(); return; }
    if (!banner) {
      banner = document.createElement('aside');
      banner.id = 'siteAnnouncement';
      banner.className = 'site-announcement';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      document.body.prepend(banner);
    }
    banner.lang = language;
    banner.dataset.level = settings.maintenance ? 'warning' : settings.announcementLevel || 'info';
    banner.replaceChildren();
    if (settings.maintenance) {
      const notice = document.createElement('p');
      notice.textContent = settings.maintenanceMessage || (language === 'fr'
        ? 'Maintenance en cours. Certaines fonctions sont temporairement indisponibles.'
        : 'Maintenance in progress. Some features are temporarily unavailable.');
      banner.append(notice);
    }
    if (settings.announcement) {
      const message = document.createElement('p');
      message.textContent = settings.announcement;
      banner.append(message);
    }
  }
  function preferredLanguage() {
    try {
      const saved = localStorage.getItem('audit-hub-language');
      if (Object.hasOwn(labels, saved)) return saved;
    } catch { /* Language remains available when browser storage is disabled. */ }
    return (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }
  function translate(language) {
    if (!Object.hasOwn(labels, language)) return;
    footer.lang = language;
    footer.querySelectorAll('[data-shell-text]').forEach(element => {
      const text = labels[language][element.dataset.shellText];
      if (text) element.textContent = text;
    });
    displayAnnouncement(language);
  }
  translate(preferredLanguage());
  document.addEventListener('audit-hub:language', event => translate(event.detail?.language));
  footer.querySelector('[data-manage-cookies]').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('audit-hub:cookie-preferences'));
  });
  function configure(kind, href) {
    footer.querySelectorAll(`[data-contact="${kind}"]`).forEach(link => {
      link.hidden = !href;
      if (!href) { link.removeAttribute('href'); return; }
      link.href = href;
      if (kind !== 'email') { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    });
  }
  function publicUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || localHttp) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  fetch('/api/site/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(config => {
    if (!config) return;
    siteSettings = config;
    displayAnnouncement();
    const email = typeof config.supportEmail === 'string' ? config.supportEmail.trim() : '';
    const validEmail = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) && !/[\r\n]/.test(email);
    const discord = publicUrl(config.discordUrl);
    configure('email', validEmail ? 'mailto:' + encodeURIComponent(email).replace(/%40/g, '@') : '');
    configure('discord', discord);
    configure('status', publicUrl(config.statusUrl));
    footer.querySelectorAll('[data-support-email]').forEach(element => { element.textContent = validEmail ? email : ''; });
    footer.querySelector('[data-footer-support]').hidden = !validEmail && !discord;
  }).catch(() => {});
})();
