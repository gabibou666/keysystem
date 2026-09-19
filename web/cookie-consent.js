/**
 * KeySystem - Gestionnaire de Consentement Cookies conforme RGPD / CNIL
 * Respecte les delibérations CNIL n° 2020-091 et 2020-092 :
 * - Aucun traceur publicitaire sans consentement explicite prealable
 * - Bouton 'Refuser' avec la meme mise en valeur que 'Accepter'
 * - Duree de validite du consentement : 6 mois
 * - Possibilite de retirer ou modifier son consentement a tout moment
 */

(function() {
  const CONSENT_KEY = 'ks_cookie_consent';
  const CONSENT_DURATION_MS = 180 * 24 * 60 * 60 * 1000; // 6 mois (CNIL)
  const AD_SCRIPT_SRC = 'https://www.highrevenueformat.com/77389bd3deefc49e2ab9e702f1a05cbb/invoke.js';

  function getStoredConsent() {
    try {
      const raw = localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.timestamp > CONSENT_DURATION_MS) {
        localStorage.removeItem(CONSENT_KEY);
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function setConsent(choice) {
    try {
      const data = {
        choice: choice, // 'all' | 'essential'
        ads: choice === 'all',
        timestamp: Date.now(),
      };
      localStorage.setItem(CONSENT_KEY, JSON.stringify(data));
      applyConsent(data);
    } catch (e) {
      console.warn('[cookie-consent]', e);
    }
  }

  function applyConsent(data) {
    if (data && data.ads) {
      loadAdScript();
    }
    closeBanner();
    closeModal();
  }

  function loadAdScript() {
    if (document.getElementById('ks-ad-script')) return;
    const script = document.createElement('script');
    script.id = 'ks-ad-script';
    script.src = AD_SCRIPT_SRC;
    script.async = true;
    document.head.appendChild(script);
  }

  function createBannerDOM() {
    if (document.getElementById('ksCookieBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'ksCookieBanner';
    banner.className = 'ks-cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-labelledby', 'ksCookieTitle');
    banner.setAttribute('aria-describedby', 'ksCookieDesc');

    banner.innerHTML = `
      <h3 id="ksCookieTitle">🍪 Respect de votre vie privée</h3>
      <p id="ksCookieDesc">
        Nous utilisons des cookies nécessaires au fonctionnement du site (session admin, sécurité).
        Avec votre accord, nous utilisons également des traceurs publicitaires pour financer la gratuité de notre service.
        Consultez notre <a href="/cookies.html" target="_blank">Politique des cookies</a> et notre <a href="/privacy.html" target="_blank">Politique de confidentialité</a>.
      </p>
      <div class="ks-cookie-btns">
        <button type="button" class="ks-cookie-btn accept" id="ksAcceptAll">Tout accepter</button>
        <button type="button" class="ks-cookie-btn reject" id="ksRejectAll">Tout refuser</button>
        <button type="button" class="ks-cookie-btn customize" id="ksCustomize">Personnaliser mes choix</button>
      </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('ksAcceptAll').addEventListener('click', () => setConsent('all'));
    document.getElementById('ksRejectAll').addEventListener('click', () => setConsent('essential'));
    document.getElementById('ksCustomize').addEventListener('click', openModal);
  }

  function createModalDOM() {
    if (document.getElementById('ksCookieModalOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'ksCookieModalOverlay';
    overlay.className = 'ks-cookie-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ksModalTitle');

    overlay.innerHTML = `
      <div class="ks-cookie-modal">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h3 id="ksModalTitle" style="margin:0;font-size:18px;color:#ffffff;">⚙️ Préférences de Cookies</h3>
          <button type="button" id="ksCloseModalBtn" style="background:none;border:none;color:var(--color-muted-2);font-size:20px;cursor:pointer;">✕</button>
        </div>
        <p style="color:var(--color-muted);font-size:13px;line-height:1.6;margin-bottom:18px;">
          Vous pouvez choisir d'activer ou de désactiver chaque catégorie de cookies. Les cookies nécessaires ne peuvent pas être désactivés car ils sont indispensables au service.
        </p>

        <div class="ks-cookie-item">
          <div>
            <h4>Cookies strictement nécessaires</h4>
            <p>Indispensables au fonctionnement technique (session, sécurité anti-DDoS). Exemptés de consentement.</p>
          </div>
          <div>
            <input type="checkbox" checked disabled style="accent-color:var(--color-accent);width:18px;height:18px;cursor:not-allowed;">
          </div>
        </div>

        <div class="ks-cookie-item">
          <div>
            <h4>Publicités & Monétisation</h4>
            <p>Permet l'affichage de publicités non intrusives via nos partenaires pour maintenir le service gratuit.</p>
          </div>
          <div>
            <input type="checkbox" id="ksAdsToggle" style="accent-color:var(--color-accent);width:18px;height:18px;cursor:pointer;">
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:20px;">
          <button type="button" class="ks-cookie-btn accept" id="ksSaveCustom" style="flex:1;">Enregistrer mes préférences</button>
          <button type="button" class="ks-cookie-btn reject" id="ksRejectCustom" style="flex:1;">Tout refuser</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('ksCloseModalBtn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    document.getElementById('ksSaveCustom').addEventListener('click', () => {
      const adsAccepted = document.getElementById('ksAdsToggle').checked;
      setConsent(adsAccepted ? 'all' : 'essential');
    });

    document.getElementById('ksRejectCustom').addEventListener('click', () => {
      setConsent('essential');
    });
  }

  function closeBanner() {
    const banner = document.getElementById('ksCookieBanner');
    if (banner) banner.remove();
  }

  function openModal() {
    createModalDOM();
    const stored = getStoredConsent();
    const adsToggle = document.getElementById('ksAdsToggle');
    if (adsToggle) {
      adsToggle.checked = stored ? !!stored.ads : false;
    }
    const overlay = document.getElementById('ksCookieModalOverlay');
    if (overlay) overlay.classList.add('open');
  }

  function closeModal() {
    const overlay = document.getElementById('ksCookieModalOverlay');
    if (overlay) overlay.classList.remove('open');
  }

  // Expose global function to allow users to change choices anytime
  window.openCookieSettings = openModal;

  // Initialize on page load
  document.addEventListener('DOMContentLoaded', () => {
    const consent = getStoredConsent();
    if (!consent) {
      createBannerDOM();
    } else {
      applyConsent(consent);
    }
  });
})();
