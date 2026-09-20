// guard.js — Anti-adblock.
// ----------------------------------------------------------------------------
// Le site est financé par la publicité, mais l'ancien comportement bloquait
// TOUT le site, sur TOUTES les pages, et relançait une requête toutes les 3
// secondes (1 200 requêtes/heure/onglet). Conséquences:
//   - la page de PAIEMENT Robux était bloquée alors qu'aucune pub n'y est
//     nécessaire: on punissait des clients qui payent;
//   - les navigateurs stricts (Brave Shields, Firefox strict, DNS filtrant en
//     entreprise) rendaient le site inutilisable sans recours;
//   - bruit réseau inutile + faux positifs sur réseau lent.
//
// Nouvelle règle: le blocage strict ne s'applique QU'aux pages du parcours de
// clé (accueil + getkey), là où la monétisation est indispensable. Ailleurs, la
// détection est passive (aucun impact utilisateur). Cadence adaptative.
(function () {
  'use strict';

  var CHECK_BLOCKED_MS = 5000; // adblock détecté: on re-teste vite (l'utilisateur corrige)
  var CHECK_CLEAN_MS = 60000; // tout va bien: une vérification par minute suffit
  var FETCH_BAIT_TIMEOUT_MS = 5000;

  // Pages où le blocage est appliqué (parcours de clé uniquement)
  var ENFORCED = ['/', '/getkey', '/getkey/callback'];
  var path = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : '/';
  var enforce = ENFORCED.indexOf(path) !== -1;

  var overlay = null;
  var overlayShown = false;
  var timer = null;

  // ===== Detection (signaux DYNAMIQUES: re-evalues a chaque cycle) =====
  // Le bait statique (script /ads.js) est bloquable une fois pour toutes: si
  // l'adblock l'a bloqué au chargement, le flag reste absent pour toujours, même
  // après désactivation. On re-injecte donc le bait div à CHAQUE cycle.
  function detectAdblock() {
    var old = document.getElementById('adBait-global');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var bait = document.createElement('div');
    bait.id = 'adBait-global';
    bait.className = 'ad-banner';
    bait.setAttribute('style', 'height: 1px; width: 1px; position: absolute; left: -9999px;');
    bait.innerHTML = '<span class="adsbox" style="font-size:1px;">Advertisement</span>';
    (document.body || document.documentElement).appendChild(bait);

    var cs = getComputedStyle(bait);
    if (cs.display === 'none' || cs.visibility === 'hidden' || bait.offsetHeight === 0 || bait.offsetParent === null) {
      return true;
    }
    // NB: /ads.js n'est PAS inclus en <script> dans les pages (il ne sert que de
    // leurre fetche): on ne peut donc pas se fier a window.adblockDetectedBait,
    // sinon un adblock serait "detecte" en permanence. Le leurre CSS ci-dessus
    // et le fetch bait sont les deux seuls signaux fiables.
    return false;
  }

  // Fetch bait asynchrone (3e vecteur).
  // Un adblock rejette la requête => true. Un réseau lent/offline (timeout 5 s)
  // est "indéterminé": on ne bloque PAS sur un problème réseau, seul un adblock
  // réel (rejet instantané) est détecté.
  function detectFetchBait() {
    return new Promise(function (resolve) {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timedOut = false;
      var t = controller
        ? setTimeout(function () {
            timedOut = true;
            controller.abort();
          }, FETCH_BAIT_TIMEOUT_MS)
        : null;
      fetch('/ads.js?bait=' + Date.now(), { cache: 'no-store', signal: controller ? controller.signal : undefined })
        .then(function () {
          if (t) clearTimeout(t);
          resolve(false);
        })
        .catch(function () {
          if (t) clearTimeout(t);
          resolve(!timedOut);
        });
    });
  }

  // ===== UI: overlay bloquant (pages de clé uniquement) =====
  function buildOverlay() {
    var ov = document.createElement('div');
    ov.id = 'adblock-guard-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'adblockGuardTitle');
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
      'overflow: auto',
    ].join(';');
    ov.innerHTML =
      '<div style="max-width: 540px; margin: 20px; padding: 28px; border-radius: 16px; ' +
      'background: #13101ccc; border: 1px solid #6d28d980; text-align: center; color: #fff;">' +
      '<div style="font-size: 44px; margin-bottom: 10px;">🚫</div>' +
      '<h2 id="adblockGuardTitle" style="margin: 0 0 8px; font-size: 24px;">Ad blocker detected</h2>' +
      '<p style="margin: 0 0 18px; color: #ffffffa8; font-size: 15px; line-height: 1.6;">' +
      'This site stays free thanks to ads — the key page can\'t work while your ad blocker is active.<br>' +
      'Allow <b style="color:#c084fc;">' + location.hostname + '</b> and it unlocks automatically.</p>' +
      '<div style="padding: 14px; border-radius: 10px; background: #0b0812; ' +
      'border: 1px solid #ffffff14; color: #ffffffa8; font-size: 13.5px; line-height: 1.8; text-align: left;">' +
      '<b style="color:#fff;">Quick fix:</b><br>' +
      '1. Click your ad blocker icon in the toolbar<br>' +
      '2. Pause it / allow this site<br>' +
      '3. This page unlocks by itself (re-checked every 5 seconds)</div>' +
      '<p style="margin: 14px 0 0; color: #ffffff70; font-size: 12.5px; line-height: 1.6;">' +
      'Using Brave or a strict DNS filter? Add an exception for ' + location.hostname + '.<br>' +
      'Prefer paying with Robux? <a href="/robux" style="color:#c084fc;">That page needs no ads</a>.</p>' +
      '<button id="adblock-guard-recheck" type="button" style="margin-top: 18px; padding: 10px 22px; border-radius: 10px; ' +
      'border: 1px solid #6d28d9; background: #6d28d9; color: #fff; font-size: 14px; cursor: pointer;">↻ Re-check now</button>' +
      '</div>';
    // Listener attaché UNE fois à la création (l'overlay est réutilisé)
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
    // Bloque le scroll (desktop + iOS: élément ET body + touch-action none)
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    var btn = overlay.querySelector('#adblock-guard-recheck');
    if (btn) btn.focus();
  }

  function hideOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    overlayShown = false;
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(check, delay);
  }

  function check() {
    Promise.resolve()
      .then(detectAdblock)
      .then(function (blockedByStatic) {
        if (blockedByStatic) return true;
        return detectFetchBait();
      })
      .then(function (blocked) {
        if (!blocked) {
          if (overlayShown) hideOverlay();
          schedule(CHECK_CLEAN_MS);
          return;
        }
        if (enforce) {
          showOverlay();
          schedule(CHECK_BLOCKED_MS);
        } else {
          // Page non monétisée (paiement Robux, pages légales, changelog...):
          // on ne bloque JAMAIS, on repart sur la cadence normale.
          schedule(CHECK_CLEAN_MS);
        }
      })
      .catch(function () {
        // Erreur inattendue: on ne bloque pas sur une erreur de détection
        schedule(CHECK_CLEAN_MS);
      });
  }

  // ===== Demarrage =====
  // Pas de bait statique: la détection est entièrement dynamique (detectAdblock
  // ré-injecte le bait à chaque cycle) — recovery sans recharger la page.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }

  // Onglet en arrière-plan: aucun contrôle (économie de requêtes et de CPU).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') check();
  });
})();
