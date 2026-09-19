/**
 * AUDIT HUB - Cookie Consent Manager (GDPR / CNIL Compliant)
 * Strictly follows CNIL Deliberations 2020-091 & 2020-092 & GDPR:
 * - No advertising trackers before explicit opt-in
 * - "Reject All" button is presented with equal prominence to "Accept All"
 * - Consent duration: 6 months
 * - Ability to withdraw or modify consent at any time
 */

(function() {
  const CONSENT_KEY = 'ks_cookie_consent';
  const CONSENT_DURATION_MS = 180 * 24 * 60 * 60 * 1000; // 6 months (CNIL)
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
    const banners = document.querySelectorAll('.ad-banner');
    if (!banners || !banners.length) return;

    banners.forEach((banner) => {
      // Avoid injecting multiple times in the same container
      if (banner.querySelector('script[src*="highrevenueformat.com"]')) return;

      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = AD_SCRIPT_SRC;
      banner.appendChild(script);
    });
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
      <h3 id="ksCookieTitle">🍪 We Value Your Privacy</h3>
      <p id="ksCookieDesc">
        We use essential cookies to operate and secure our service (sessions, anti-DDoS).
        With your consent, we also use third-party advertising cookies to keep our service completely free.
        Read our <a href="/cookies" target="_blank">Cookie Policy</a> and <a href="/privacy" target="_blank">Privacy Policy</a>.
      </p>
      <div class="ks-cookie-btns">
        <button type="button" class="ks-cookie-btn accept" id="ksAcceptAll">Accept All</button>
        <button type="button" class="ks-cookie-btn reject" id="ksRejectAll">Reject All</button>
        <button type="button" class="ks-cookie-btn customize" id="ksCustomize">Customize Choices</button>
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
          <h3 id="ksModalTitle" style="margin:0;font-size:18px;color:#ffffff;">⚙️ Cookie Preferences</h3>
          <button type="button" id="ksCloseModalBtn" style="background:none;border:none;color:var(--color-muted-2);font-size:20px;cursor:pointer;" aria-label="Close">✕</button>
        </div>
        <p style="color:var(--color-muted);font-size:13px;line-height:1.6;margin-bottom:18px;">
          You can choose to enable or disable specific categories of cookies. Essential cookies cannot be disabled as they are technically necessary to operate and secure the platform.
        </p>

        <div class="ks-cookie-item">
          <div>
            <h4>Strictly Necessary Cookies</h4>
            <p>Essential for technical operation, admin session authentication, and anti-DDoS security. Exempt from consent.</p>
          </div>
          <div>
            <input type="checkbox" checked disabled style="accent-color:var(--color-accent);width:18px;height:18px;cursor:not-allowed;" aria-label="Strictly necessary cookies (required)">
          </div>
        </div>

        <div class="ks-cookie-item">
          <div>
            <h4>Advertising & Monetization</h4>
            <p>Allows non-intrusive sponsor ads via our partners to support and maintain our free services.</p>
          </div>
          <div>
            <input type="checkbox" id="ksAdsToggle" style="accent-color:var(--color-accent);width:18px;height:18px;cursor:pointer;" aria-label="Advertising cookies">
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:20px;">
          <button type="button" class="ks-cookie-btn accept" id="ksSaveCustom" style="flex:1;">Save Preferences</button>
          <button type="button" class="ks-cookie-btn reject" id="ksRejectCustom" style="flex:1;">Reject All</button>
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
