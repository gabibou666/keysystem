'use strict';

// Resolve the language before the body is parsed, keeping the English fallback usable.
(() => {
  const availableLanguages = new Set(['en', 'fr']);
  let preferredLanguage = 'en';
  try {
    const saved = localStorage.getItem('audit-hub-language');
    const browserLanguage = navigator.languages?.[0] || navigator.language || 'en';
    preferredLanguage = availableLanguages.has(saved) ? saved : browserLanguage.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    preferredLanguage = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }
  let language = preferredLanguage;
  let dictionary = {};
  let siteStats = null;
  let languageRequest = 0;
  const translationCache = new Map();
  const scriptVersion = document.currentScript?.src ? new URL(document.currentScript.src).search : '';
  const initialTranslation = preferredLanguage === 'fr' ? readTranslations('fr') : null;
  let pendingTimeout;
  if (preferredLanguage === 'fr') {
    document.documentElement.dataset.i18nPending = 'true';
    pendingTimeout = window.setTimeout(revealPage, 1200);
  }

  function revealPage() {
    delete document.documentElement.dataset.i18nPending;
    window.clearTimeout(pendingTimeout);
  }

  async function readTranslations(code) {
    if (translationCache.has(code)) return translationCache.get(code);
    const request = fetch(`/i18n/landing.${code}.json${scriptVersion}`, { credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw new Error('Translation unavailable');
        return response.json();
      })
      .then(value => value && typeof value === 'object' && !Array.isArray(value) ? value : null)
      .catch(() => null);
    translationCache.set(code, request);
    return request;
  }

  function translate(dict) {
    const textFor = key => typeof dict[key] === 'string' ? dict[key] : undefined;
    document.querySelectorAll('[data-i18n]').forEach(element => {
      const value = textFor(element.dataset.i18n);
      if (value !== undefined) element.textContent = value;
    });
    for (const attribute of ['alt', 'aria-label', 'content']) {
      document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
        const value = textFor(element.getAttribute(`data-i18n-${attribute}`));
        if (value !== undefined) element.setAttribute(attribute, value);
      });
    }
    if (textFor('page.title')) document.title = dict['page.title'];
    document.documentElement.lang = language;
    document.getElementById('languageSelect').value = language;
    updateMenuLabel();
    renderStats();
    document.dispatchEvent(new CustomEvent('audit-hub:language', { detail: { language } }));
  }

  async function setLanguage(code, persist = false) {
    if (!availableLanguages.has(code)) return;
    const requestNumber = ++languageRequest;
    const next = code === 'fr' && initialTranslation ? await initialTranslation : await readTranslations(code);
    if (requestNumber !== languageRequest) return;
    if (next) {
      language = code;
      dictionary = next;
      translate(next);
    } else {
      // A failed request preserves the complete English content already in the page.
      language = document.documentElement.lang === 'fr' ? 'fr' : 'en';
      document.getElementById('languageSelect').value = language;
    }
    if (persist) {
      try { localStorage.setItem('audit-hub-language', language); } catch { /* Storage is optional. */ }
    }
    revealPage();
  }

  function updateMenuLabel() {
    const toggle = document.querySelector('.nav-toggle');
    if (!toggle) return;
    const open = document.body.classList.contains('nav-open');
    const key = open ? 'nav.close' : 'nav.menu';
    toggle.setAttribute('aria-label', dictionary[key] || (open ? 'Close navigation' : 'Open navigation'));
    toggle.querySelector('use')?.setAttribute('href', `/icons/lucide.svg${scriptVersion}#${open ? 'x' : 'menu'}`);
  }

  function setMenu(open, focusFirst = false) {
    document.body.classList.toggle('nav-open', open);
    document.querySelector('.nav-toggle').setAttribute('aria-expanded', String(open));
    updateMenuLabel();
    if (open && focusFirst) document.querySelector('#mainNavigation a')?.focus();
  }

  function safeSupportUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value);
      const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || localHttp) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  function configureLink(kind, url) {
    document.querySelectorAll(`[data-contact="${kind}"]`).forEach(link => {
      if (!url) { link.hidden = true; link.removeAttribute('href'); return; }
      link.href = url;
      link.hidden = false;
      if (/^https?:/.test(url) && new URL(url).origin !== location.origin) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    });
  }

  async function loadSiteConfig() {
    try {
      const response = await fetch('/api/site/config', { credentials: 'same-origin' });
      if (!response.ok) return;
      const config = await response.json();
      const email = typeof config.supportEmail === 'string' ? config.supportEmail.trim() : '';
      const validEmail = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) && !/[\r\n]/.test(email);
      const discord = safeSupportUrl(config.discordUrl);
      configureLink('email', validEmail ? `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}` : '');
      document.querySelectorAll('[data-support-email]').forEach(element => { element.textContent = validEmail ? email : ''; });
      configureLink('discord', discord);
      configureLink('status', safeSupportUrl(config.statusUrl));
      document.querySelectorAll('[data-support-links]').forEach(element => { element.hidden = !validEmail && !discord; });
      document.querySelectorAll('[data-support-fallback]').forEach(element => { element.hidden = validEmail || Boolean(discord); });
    } catch { /* Optional support settings must never prevent the landing page from loading. */ }
  }

  function renderStats() {
    if (!siteStats) return;
    const formatter = new Intl.NumberFormat(language === 'fr' ? 'fr-FR' : 'en-US');
    for (const kind of ['projects', 'licenses', 'scripts']) {
      document.querySelector(`[data-stat="${kind}"]`).textContent = formatter.format(siteStats[kind]);
    }
    document.getElementById('siteStatistics').hidden = false;
  }

  async function loadSiteStats() {
    try {
      const response = await fetch('/api/site/stats', { credentials: 'same-origin' });
      if (!response.ok) return;
      const stats = await response.json();
      if (stats.visible !== true || !['projects', 'licenses', 'scripts'].every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0)) return;
      siteStats = stats;
      renderStats();
    } catch { /* Low or unavailable counts remain hidden. */ }
  }

  function start() {
    // The actual DOM provides the default dictionary, including accessible labels.
    document.querySelectorAll('[data-i18n]').forEach(element => { dictionary[element.dataset.i18n] = element.textContent; });
    for (const attribute of ['alt', 'aria-label', 'content']) {
      document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
        dictionary[element.getAttribute(`data-i18n-${attribute}`)] = element.getAttribute(attribute);
      });
    }
    dictionary['page.title'] = document.title;
    translationCache.set('en', Promise.resolve(dictionary));
    document.getElementById('languageSelect').value = preferredLanguage;
    document.getElementById('languageSelect').addEventListener('change', event => setLanguage(event.target.value, true));
    document.querySelector('.nav-toggle').addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open'), true));
    document.querySelectorAll('#mainNavigation a').forEach(link => link.addEventListener('click', () => setMenu(false)));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
        setMenu(false);
        document.querySelector('.nav-toggle').focus();
      }
    });
    document.addEventListener('click', event => {
      if (document.body.classList.contains('nav-open') && !event.target.closest('.landing-header')) setMenu(false);
    });
    const mobileNavigation = window.matchMedia('(max-width: 960px)');
    mobileNavigation.addEventListener('change', () => setMenu(false));
    document.querySelectorAll('.faq-list details').forEach(detail => {
      detail.addEventListener('toggle', () => {
        if (detail.open) document.querySelectorAll('.faq-list details').forEach(other => { if (other !== detail) other.open = false; });
      });
    });
    if (location.hash === '#pricing') {
      history.replaceState(null, '', `${location.pathname}${location.search}#free-plan`);
      document.getElementById('free-plan').scrollIntoView();
    }
    if (preferredLanguage === 'fr') setLanguage('fr');
    else { language = 'en'; revealPage(); }
    loadSiteConfig();
    loadSiteStats();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
