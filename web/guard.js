// guard.js — Anti-adblock global pour tout le site.
// Charge sur toutes les pages publiques (index, getkey, robux, changelog).
// Principe: detection multi-vecteurs (bait /ads.js + bait div CSS + fetch bait),
// si un adblock est actif => overlay plein ecran bloquant jusqu'a desactivation.
// Re-check automatique toutes les 3 s: l'overlay disparait des l'adblock coupe.
(function () {
  'use strict';

  var CHECK_INTERVAL_MS = 3000;
  var FETCH_BAIT_TIMEOUT_MS = 5000;
  var overlay = null;
  var overlayShown = false;

  // ===== Detection (3 vecteurs, memes que /verify) =====
  function detectAdblock() {
    // 1) Bait script: /ads.js bloque par les listes de filtres => flag absent
    if (!window.adblockDetectedBait) return true;
    // 2) Bait div CSS: les filtres masquent les divs "pub" par regles CSS
    var bait = document.getElementById('adBait-global');
    if (bait) {
      var cs = getComputedStyle(bait);
      if (cs.display === 'none' || cs.visibility === 'hidden' || bait.offsetHeight === 0 || bait.offsetParent === null) return true;
    }
    return false;
  }

  // Fetch bait asynchrone (3e vecteur).
  // Un adblock rejette la requete => true. Un reseau lent/offline (timeout
  // 5 s) est "indetermine": on ne bloque PAS sur un probleme reseau, seul un
  // adblock reelle (rejet instantane) est sanctionne.
  function detectFetchBait() {
    return new Promise(function (resolve) {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timedOut = false;
      var timer = controller
        ? setTimeout(function () { timedOut = true; controller.abort(); }, FETCH_BAIT_TIMEOUT_MS)
        : null;
      fetch('/ads.js?bait=' + Date.now(), { cache: 'no-store', signal: controller ? controller.signal : undefined })
        .then(function () { if (timer) clearTimeout(timer); resolve(false); })
        .catch(function () { if (timer) clearTimeout(timer); resolve(!timedOut); });
    });
  }

  // ===== UI: overlay bloquant plein ecran =====
  function buildOverlay() {
    var ov = document.createElement('div');
    ov.id = 'adblock-guard-overlay';
    ov.style.cssText = [
      'position: fixed',
      'top: 0',
      'right: 0',
      'bottom: 0',
      'left: 0',
      'z-index: 2147483647',
      'background: #0b0812fa',
      'backdrop-filter: blur(6px)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'font-family: inherit',
      'touch-action: none',
      'overflow: hidden'
    ].join(';');
    ov.innerHTML =
      '<div style="max-width: 520px; margin: 20px; padding: 28px; border-radius: 16px; ' +
      'background: #13101ccc; border: 1px solid #6d28d980; text-align: center; color: #fff;">' +
      '<div style="font-size: 44px; margin-bottom: 10px;">🚫</div>' +
      '<h2 style="margin: 0 0 8px; font-size: 24px;">Ad blocker detected</h2>' +
      '<p style="margin: 0 0 18px; color: #ffffffa8; font-size: 15px; line-height: 1.6;">' +
      'This site is funded by ads — it can\'t work with your ad blocker active.<br>' +
      'Disable it for <b style="color:#c084fc;">' + location.hostname + '</b> to continue.</p>' +
      '<div style="padding: 14px; border-radius: 10px; background: #0b0812; ' +
      'border: 1px solid #ffffff14; color: #ffffffa8; font-size: 13.5px; line-height: 1.8; text-align: left;">' +
      '<b style="color:#fff;">How to disable it:</b><br>' +
      '1. Click your ad blocker icon in the toolbar<br>' +
      '2. Pause it on this site<br>' +
      '3. This overlay disappears automatically (~3 seconds after)</div>' +
      '<button id="adblock-guard-recheck" style="margin-top: 18px; padding: 10px 22px; border-radius: 10px; ' +
      'border: 1px solid #6d28d9; background: #6d28d9; color: #fff; font-size: 14px; cursor: pointer;">↻ Re-check now</button>' +
      '</div>';
    // Listener attache UNE fois a la creation (l'overlay est reutilise, pas recree)
    var btn = ov.querySelector('#adblock-guard-recheck');
    if (btn) btn.addEventListener('click', check);
    return ov;
  }

  function showOverlay() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showOverlay);
      return;
    }
    if (overlayShown) return;
    overlayShown = true;
    if (!overlay) overlay = buildOverlay();
    document.body.appendChild(overlay);
    // Bloque le scroll (desktop + iOS: element ET body + touch-action none)
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }

  function hideOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    overlayShown = false;
  }

  function check() {
    Promise.resolve()
      .then(detectAdblock)
      .then(function (blockedByStatic) {
        if (blockedByStatic) return true;
        return detectFetchBait();
      })
      .then(function (blocked) {
        if (blocked) showOverlay();
        else if (overlayShown) hideOverlay();
      })
      .catch(function () {
        // Erreur inattendue: on ne bloque pas sur une erreur de detection
      });
  }

  // ===== Demarrage =====
  // Bait div injecte des que le DOM est pret
  function injectBait() {
    if (document.getElementById('adBait-global')) return;
    var b = document.createElement('div');
    b.id = 'adBait-global';
    b.className = 'ad-banner';
    b.setAttribute('style', 'height: 1px; width: 1px; position: absolute; left: -9999px;');
    b.innerHTML = '<span class="adsbox" style="font-size:1px;">Advertisement</span>';
    (document.body || document.documentElement).appendChild(b);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectBait(); check(); });
  } else {
    injectBait();
    check();
  }

  // Re-check perpetuel: l'overlay reaparait si l'adblock est reactive,
  // disparait des qu'il est coupe. Un timer 3 s par page n'est pas une fuite.
  setInterval(check, CHECK_INTERVAL_MS);
})();
