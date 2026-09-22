// ===== Parametres =====
// p = PALIER choisi sur getkey.html (identifiant d'offre, tel quel):
//   lootlabs       = LootLabs 1 publicite  -> cle de 12 h
//   lootlabs_2ads  = LootLabs 2 publicites -> cle de 24 h
//   workink        = Work.ink 1 publicite  -> cle de 24 h
// Toute autre valeur (ou l'absence de p) retombe sur le palier historique
// lootlabs: le serveur reste seul juge de la validite d'une offre, la page ne
// refuse jamais a sa place. k=1 = renouvellement d'une cle existante.
// C'est le SERVEUR qui decide le nombre de publicites ET la duree de la cle
// d'apres le palier: la page ne transmet jamais ni duree ni nombre de pubs.
const q = new URLSearchParams(location.search);
const OFFRES_CONNUES = ['lootlabs', 'lootlabs_2ads', 'workink'];
const offreDemandee = (q.get('p') || '').trim().toLowerCase();
const offer = OFFRES_CONNUES.includes(offreDemandee) ? offreDemandee : 'lootlabs';
const renewing = q.get('k') === '1';

const KEY_STORAGE = 'keysystem_key';
const PUID_STORAGE = 'keysystem_pending_puid';

let sessionStarting = false; // session en cours de demarrage (redirection imminente)
let checkInFlight = false;   // garde synchrone anti-double-check

// ===== Detection adblock (signaux DYNAMIQUES: re-evalues a chaque cycle) =====
// Le bait statique (script /ads.js en head) est bloquable une fois pour toutes:
// si l'adblock l'a bloque au chargement, le flag reste absent pour toujours,
// meme apres desactivation de l'adblock. On utilise donc des signaux RE-INJECTES
// a chaque cycle: la detection se retablit sans recharger la page.
async function detectAdblock() {
  // 1) Bait div CSS re-injecte: les filtres masquent les divs "pub" par regles CSS
  const old = document.getElementById('adBait');
  if (old) old.remove();
  const bait = document.createElement('div');
  bait.id = 'adBait';
  bait.className = 'ad-banner';
  bait.setAttribute('style', 'height: 1px; width: 1px; position: absolute; left: -9999px;');
  bait.innerHTML = '<span class="adsbox" style="font-size:1px;">Advertisement</span>';
  document.body.appendChild(bait);
  const cs = getComputedStyle(bait);
  if (cs.display === 'none' || cs.visibility === 'hidden' || bait.offsetHeight === 0 || bait.offsetParent === null) return true;

  // 2) Fetch du bait lui-meme (requests bloquees par uBlock/Brave...)
  //    Timeout 5 s: un reseau lent/offline est "indetermine" => on ne bloque pas
  const fetchBlocked = await new Promise((resolve) => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    const timer = controller
      ? setTimeout(() => { timedOut = true; controller.abort(); }, 5000)
      : null;
    fetch('/ads.js?bait=' + Date.now(), { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(() => { if (timer) clearTimeout(timer); resolve(false); })
      .catch(() => { if (timer) clearTimeout(timer); resolve(!timedOut); });
  });
  if (fetchBlocked) return true;

  return false;
}

// ===== Enchainement =====
async function runCheck() {
  // Garde SYNCHRONE avant tout await: empeche tick 3s + clic Re-check
  // concurrents de doubler le POST /api/key/start (fetch lent / reseau lent)
  if (sessionStarting || checkInFlight) return;
  checkInFlight = true;
  try {
    const blocked = await detectAdblock();

    if (!blocked) {
      // OK -> redirection instantanee vers le systeme de cles LootLabs
      sessionStarting = true;
      stopLoop();
      document.getElementById('checkingPanel').classList.add('hidden');
      document.getElementById('blockedPanel').classList.add('hidden');
      document.getElementById('passPanel').classList.remove('hidden');
      document.title = 'Verified!';
      await startKeySession();
      return;
    }

    // BLOQUE
    document.getElementById('checkingPanel').classList.add('hidden');
    document.getElementById('passPanel').classList.add('hidden');
    document.getElementById('blockedPanel').classList.remove('hidden');
    document.title = 'Ad blocker detected';
  } catch (e) {
    // Erreur inattendue: le prochain tick re-essaiera (self-healing)
    console.warn('[verify]', e);
  } finally {
    checkInFlight = false;
  }
}

// Re-test automatique toutes les 3 s tant que l'adblock est actif
// Cadence 5 s (avant 3 s): suffisant pour detecter la correction, 40 % de
// requetes en moins, et la boucle s'arrete des que la session demarre.
let loopTimer = setInterval(runCheck, 5000);
function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }

// ===== Demarrage de la session publicitaire (meme logique que getkey.html) =====
// Le palier part sous le nom 'offer' (le serveur accepte aussi 'provider' pour
// les clients anterieurs): c'est LUI qui fixe le nombre de pubs et la duree.
async function startKeySession() {
  let body = { offer };
  const existing = localStorage.getItem(KEY_STORAGE);
  if (renewing && existing) body.key = existing;
  const ref = localStorage.getItem('keysystem_ref');
  if (ref) body.ref = ref;

  try {
    const r = await fetch('/api/key/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.success) {
      // Erreur metier (ad_limit, discord_required, provider_unavailable...):
      // panneau d'erreur VISIBLE avec le message du serveur.
      showError(d.error || 'Session could not start.', d.inviteUrl);
      return;
    }
    localStorage.setItem(PUID_STORAGE, d.puid);
    localStorage.setItem(PUID_STORAGE + '_time', Date.now().toString());
    // Redirection DIRECTE (meme onglet) vers l'annonce de la regie choisie.
    location.href = d.lootUrl;
  } catch (e) {
    showError('Network error — check your connection and retry.');
  }
}

// Affiche le panneau d'erreur a la place du spinner
function showError(msg, inviteUrl) {
  stopLoop();
  sessionStarting = false;
  document.getElementById('checkingPanel').classList.add('hidden');
  document.getElementById('blockedPanel').classList.add('hidden');
  document.getElementById('passPanel').classList.add('hidden');
  document.getElementById('errorPanel').classList.remove('hidden');
  const errEl = document.getElementById('errorText');
  if (inviteUrl) {
    errEl.innerHTML = `${msg}<br><a class="btn small" style="margin-top:12px; display:inline-flex; background:#5865f2; border:none;" href="${inviteUrl}" target="_blank">Join Discord Server</a>`;
  } else {
    errEl.textContent = msg;
  }
  document.title = 'Error';
}

// ===== Mobile nav =====
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

// Go
document.getElementById('hostName').textContent = location.hostname;
runCheck();
