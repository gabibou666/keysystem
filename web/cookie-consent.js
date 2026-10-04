'use strict';
(() => {
  const STORAGE = 'audit-hub-cookie-consent';
  const loaders = new Set();
  let choice = null, panel, preferences = false, returnFocus, expiryTimer;
  const copy = {
    en: {
      title: 'Your privacy, your choice.', preferences: 'Cookie preferences',
      description: 'Necessary storage keeps sign-in and security working. Optional audience measurement and other storage stay off until you choose to allow them. No audience tracker is currently installed.',
      policy: 'Read the cookie policy', accept: 'Accept all', reject: 'Reject all', customize: 'Customize', save: 'Save preferences', close: 'Close preferences',
      necessary: 'Necessary', necessaryDescription: 'Always active: session, security, and Google or Discord sign-in when requested.',
      optional: 'Audience measurement / other', optionalDescription: 'Optional. Disabled by default. No audience tracker is currently installed.',
      duration: 'Your choice is saved in this browser for six months. You can change it from the footer at any time.',
      saved: 'Cookie preferences saved.', unavailable: 'This browser cannot save your choice. It applies to this page; you may be asked again on your next visit.'
    },
    fr: {
      title: 'Votre vie privée, votre choix.', preferences: 'Préférences de cookies',
      description: 'Le stockage nécessaire permet la connexion et la sécurité. La mesure d’audience et les autres usages facultatifs restent désactivés jusqu’à votre accord. Aucun outil de mesure d’audience n’est actuellement installé.',
      policy: 'Lire la politique de cookies', accept: 'Tout accepter', reject: 'Tout refuser', customize: 'Personnaliser', save: 'Enregistrer mes choix', close: 'Fermer les préférences',
      necessary: 'Nécessaires', necessaryDescription: 'Toujours actifs : session, sécurité et connexion Google ou Discord à votre demande.',
      optional: 'Mesure d’audience / autres', optionalDescription: 'Facultatif. Désactivé par défaut. Aucun outil de mesure d’audience n’est actuellement installé.',
      duration: 'Votre choix est mémorisé dans ce navigateur pendant six mois. Vous pouvez le modifier dans le pied de page à tout moment.',
      saved: 'Préférences de cookies enregistrées.', unavailable: 'Ce navigateur ne peut pas mémoriser votre choix. Il s’applique à cette page ; il pourra vous être demandé à la prochaine visite.'
    }
  };
  function language() {
    try { const saved = localStorage.getItem('audit-hub-language'); if (saved === 'fr' || saved === 'en') return saved; } catch {}
    return (navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }
  let currentLanguage = language();
  // Six calendar months, including dates at the end of a month.
  function expiresAfterSixMonths(date) {
    const expires = new Date(date);
    const day = expires.getUTCDate();
    expires.setUTCDate(1);
    expires.setUTCMonth(expires.getUTCMonth() + 6);
    const lastDay = new Date(Date.UTC(expires.getUTCFullYear(), expires.getUTCMonth() + 1, 0)).getUTCDate();
    expires.setUTCDate(Math.min(day, lastDay));
    return expires;
  }
  function readChoice() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE));
      if (!value || value.version !== 1 || value.necessary !== true || typeof value.optional !== 'boolean') return null;
      const saved = new Date(value.savedAt), expires = new Date(value.expiresAt);
      if (!Number.isFinite(saved.getTime()) || !Number.isFinite(expires.getTime()) || saved.getTime() > Date.now() + 60000 || expires.getTime() <= Date.now() || expires.getTime() !== expiresAfterSixMonths(saved).getTime()) return null;
      return value;
    } catch { return null; }
  }
  function state() { return Object.freeze({ necessary: true, optional: choice?.optional === true && new Date(choice.expiresAt).getTime() > Date.now(), savedAt: choice?.savedAt || null, expiresAt: choice?.expiresAt || null }); }
  function stopLoader(record) {
    record.active = false;
    if (typeof record.cleanup === 'function') { try { record.cleanup(); } catch {} }
    record.cleanup = null;
  }
  function scheduleExpiration() {
    clearTimeout(expiryTimer);
    if (choice) expiryTimer = setTimeout(refresh, Math.max(1, Math.min(new Date(choice.expiresAt).getTime() - Date.now() + 1, 86400000)));
  }
  function syncLoaders() {
    const allowed = choice?.optional === true && new Date(choice.expiresAt).getTime() > Date.now();
    for (const record of loaders) {
      if (!allowed) { if (record.active) stopLoader(record); continue; }
      if (record.active) continue;
      record.active = true;
      // A future optional integration must register here, never in the HTML.
      try {
        const cleanup = record.start();
        if (typeof cleanup === 'function') record.cleanup = cleanup;
      } catch { record.active = false; }
    }
    document.dispatchEvent(new CustomEvent('audit-hub:consent', { detail: state() }));
    scheduleExpiration();
  }
  function spaceForPanel() {
    document.body.style.setProperty('--cookie-consent-space', panel.hidden ? '0px' : `${panel.getBoundingClientRect().height + 24}px`);
    document.body.classList.toggle('has-cookie-consent', !panel.hidden);
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function render() {
    if (!panel) return;
    const t = copy[currentLanguage];
    const previousOptional = panel.querySelector('#cookieConsentOptional')?.checked;
    panel.replaceChildren();
    panel.lang = currentLanguage;
    const heading = element('h2', 'cookie-consent-title', preferences ? t.preferences : t.title);
    heading.id = 'cookieConsentTitle'; heading.tabIndex = -1;
    panel.append(heading, element('p', 'cookie-consent-description', t.description));
    const policy = element('a', 'cookie-consent-policy', t.policy); policy.href = '/cookies'; panel.append(policy);
    if (preferences) {
      const categories = element('div', 'cookie-consent-categories');
      for (const category of ['necessary', 'optional']) {
        const label = element('label', 'cookie-consent-category');
        const input = element('input'); input.type = 'checkbox';
        input.id = category === 'necessary' ? 'cookieConsentNecessary' : 'cookieConsentOptional';
        input.checked = category === 'necessary' || (previousOptional ?? choice?.optional ?? false);
        input.disabled = category === 'necessary';
        const text = element('span'); text.append(element('strong', '', t[category]), element('small', '', t[category + 'Description']));
        label.append(input, text); categories.append(label);
      }
      panel.append(categories);
    }
    const actions = element('div', 'cookie-consent-actions');
    for (const [action, label] of [['Accept', t.accept], ['Reject', t.reject], ['Customize', preferences ? t.save : t.customize]]) {
      const button = element('button', 'cookie-consent-button', label); button.type = 'button'; button.id = 'cookieConsent' + action;
      button.addEventListener('click', () => {
        if (action === 'Accept') save(true);
        else if (action === 'Reject') save(false);
        else if (preferences) save(panel.querySelector('#cookieConsentOptional').checked);
        else { preferences = true; render(); panel.querySelector('#cookieConsentTitle').focus(); }
      });
      actions.append(button);
    }
    panel.append(actions, element('p', 'cookie-consent-duration', t.duration));
    if (choice) {
      const close = element('button', 'cookie-consent-close', '×'); close.type = 'button'; close.setAttribute('aria-label', t.close);
      close.addEventListener('click', hide); panel.append(close);
    }
    spaceForPanel();
  }
  function hide() {
    const wasFocused = panel.contains(document.activeElement);
    panel.hidden = true; spaceForPanel();
    if (returnFocus?.isConnected) returnFocus.focus();
    else if (wasFocused) {
      const next = document.querySelector('main h1, main, .brand');
      if (next) {
        const previousTabIndex = next.getAttribute('tabindex'); next.setAttribute('tabindex', '-1'); next.focus({ preventScroll: true });
        next.addEventListener('blur', () => { if (previousTabIndex === null) next.removeAttribute('tabindex'); else next.setAttribute('tabindex', previousTabIndex); }, { once: true });
      }
    }
    returnFocus = null;
  }
  function save(optional) {
    const now = new Date();
    choice = { version: 1, necessary: true, optional: optional === true, savedAt: now.toISOString(), expiresAt: expiresAfterSixMonths(now).toISOString() };
    let persisted = true;
    try { localStorage.setItem(STORAGE, JSON.stringify(choice)); } catch { persisted = false; }
    syncLoaders(); hide();
    document.getElementById('cookieConsentStatus').textContent = copy[currentLanguage][persisted ? 'saved' : 'unavailable'];
  }
  function openPreferences() {
    if (!panel) return;
    returnFocus = document.activeElement;
    preferences = true; panel.hidden = false; render(); panel.querySelector('#cookieConsentTitle').focus();
  }
  function refresh() {
    if (choice && new Date(choice.expiresAt).getTime() <= Date.now()) {
      choice = null; try { localStorage.removeItem(STORAGE); } catch {}
      syncLoaders(); preferences = false; panel.hidden = false; render();
    } else scheduleExpiration();
  }
  window.AuditHubConsent = Object.freeze({
    getState: () => { refresh(); return state(); },
    openPreferences,
    // Returns a disposer. The integration can return a synchronous cleanup
    // function to stop itself when consent is withdrawn or expires.
    whenAllowed(category, start) {
      if (category !== 'optional' || typeof start !== 'function') throw new TypeError('Register an optional consent loader function.');
      const record = { start, active: false, cleanup: null }; loaders.add(record); syncLoaders();
      return () => { stopLoader(record); loaders.delete(record); };
    }
  });
  function initialize() {
    choice = readChoice();
    panel = element('section', 'cookie-consent'); panel.id = 'cookieConsentBanner'; panel.hidden = !!choice;
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-labelledby', 'cookieConsentTitle');
    const status = element('div', 'cookie-consent-sr-only'); status.id = 'cookieConsentStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    document.body.append(panel, status); render(); syncLoaders();
    if (typeof ResizeObserver === 'function') new ResizeObserver(spaceForPanel).observe(panel);
    else window.addEventListener('resize', spaceForPanel);
    panel.addEventListener('keydown', event => { if (event.key === 'Escape' && choice) { event.preventDefault(); hide(); } });
    window.addEventListener('storage', event => {
      if (event.key !== STORAGE && event.key !== null) return;
      choice = readChoice(); syncLoaders(); preferences = false; panel.hidden = !!choice; render();
    });
    window.addEventListener('focus', refresh);
  }
  document.addEventListener('audit-hub:cookie-preferences', openPreferences);
  document.addEventListener('audit-hub:language', event => {
    if (!['en', 'fr'].includes(event.detail?.language)) return;
    currentLanguage = event.detail.language; render();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
