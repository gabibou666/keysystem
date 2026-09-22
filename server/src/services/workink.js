// ============================================================================
// Work.ink — regie publicitaire n°2 (1 annonce = cle de 24 heures par defaut)
// ----------------------------------------------------------------------------
// Ce que dit la documentation officielle PUBLIQUE (verifiee le 22/09/2026):
//
//   1. Creation du lien d'annonce: API de liens ("Link API") du dashboard
//      (Integrations > Link API > API Keys — voir dashboard.work.ink/developer).
//      Le format exact de la requete (URL du point d'entree, en-tete
//      d'authentification, nom des champs) est documente UNIQUEMENT dans le
//      dashboard, derriere la connexion. Il n'est donc PAS devine ici:
//      l'appel n'est envoye que si WORKINK_LINK_ENDPOINT est fourni (valeur a
//      copier depuis le dashboard). Sans cle API + point d'entree complets, le
//      fournisseur est annonce INDISPONIBLE et /api/key/start le refuse
//      proprement (raison provider_unavailable) — jamais d'erreur 500.
//
//   2. Retour de l'utilisateur ("Key System"): Work.ink renvoie l'utilisateur
//      sur la destination du lien avec le parametre ?hash=<token>.
//      Sources: blog.work.ink "Using the Key System to make money with your
//      Software" (02/03/2025) et "How-To: Migrating from the Linkvertise
//      Anti-Bypass System to the Work.ink Key System" (07/05/2025).
//
//   3. Verification du postback: Work.ink ne signe PAS de postback
//      serveur-a-serveur (aucun HMAC publie). La preuve de completion est le
//      TOKEN, verifie aupres de l'API officielle:
//        GET https://work.ink/_api/v2/token/isValid/<token>
//        (+ ?deleteToken=1 pour un usage UNIQUE)
//        -> { valid, deleted, info: { token, createdAt, byIp, linkId, expiresAfter } }
//      C'est le mecanisme documente, et c'est celui implemente ici: pas de
//      "signature" inventee. Le secret partage WORKINK_POSTBACK_SECRET reste
//      notre propre porte d'entree supplementaire (comme pour LootLabs).
//
// Aucune erreur de configuration ne doit empecher le demarrage du serveur:
// l'absence de ces variables rend seulement Work.ink indisponible.
// ============================================================================

const { safeEqual } = require('./crypto');
const { optionalSecret } = require('../config-check');

// Duree de la cle delivree apres une annonce Work.ink (surchargeable).
const DEFAULT_DURATION_HOURS = 24;

// Work.ink ne propose QU'UN palier: 1 annonce = 1 cle. La valeur est gravee
// dans la session (ad_count) et le postback exige exactement ce nombre
// d'annonces terminees (voir routes/api.js).
const ADS_PER_KEY = 1;

// Point de verification des tokens (surchargeable: tests locaux sans reseau,
// ou changement d'URL cote Work.ink).
const DEFAULT_VERIFY_URL = 'https://work.ink/_api/v2/token/isValid';

function durationHours() {
  const value = parseInt(process.env.WORKINK_DURATION_HOURS || '', 10);
  return Number.isFinite(value) && value > 0 && value <= 24 * 30 ? value : DEFAULT_DURATION_HOURS;
}

function linkEndpoint() {
  return (process.env.WORKINK_LINK_URL || process.env.WORKINK_LINK_ENDPOINT || '').trim();
}

function verifyUrl() {
  return (process.env.WORKINK_VERIFY_URL || DEFAULT_VERIFY_URL).replace(/\/+$/, '');
}

// Secret partage optionnel de notre URL de retour (notre propre garde).
function postbackSecret() {
  return optionalSecret('WORKINK_POSTBACK_SECRET');
}

// Raison EXACTE pour laquelle Work.ink n'est pas proposable (null = disponible).
// Le front s'en sert pour masquer la carte; l'API la renvoie telle quelle.
function unavailableReason() {
  const endpoint = linkEndpoint();
  const isDirectWorkinkLink = /^https?:\/\/(?:[a-z0-9-]+\.)?work\.ink\//i.test(endpoint);
  if (!isDirectWorkinkLink && !optionalSecret('WORKINK_API_KEY')) return 'missing_api_key';
  if (!endpoint) return 'missing_link_endpoint';
  return null;
}

function isConfigured() {
  return unavailableReason() === null;
}

// Erreur metier explicite: la route renvoie un message lisible, jamais un 500.
function providerError(message, reason) {
  const err = new Error(`Work.ink: ${message}`);
  err.workinkMessage = message;
  err.reason = reason;
  return err;
}

function httpPostJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'KeySystem/1.0 (Windows NT 10.0; Win64; x64)',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).then(async (res) => {
    const text = await res.text().catch(() => '');
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
  });
}

// Champ qui porte l'URL courte dans la reponse de la Link API. La documentation
// du dashboard nomme ce champ: on accepte les variantes usuelles et on echoue
// PROPREMENT (message clair) si aucune n'est presente — jamais de lien invente.
function extractLinkUrl(data) {
  const sources = [data, data && data.data, data && data.link, data && data.result];
  const champs = ['url', 'link', 'short_url', 'shortUrl', 'shortenedUrl', 'linkUrl'];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const champ of champs) {
      const value = source[champ];
      if (typeof value === 'string' && value.startsWith('http')) return value;
    }
  }
  return null;
}

// Cree un lien d'annonce Work.ink qui ramene l'utilisateur sur NOTRE postback
// (puid = session, hash = token fourni par Work.ink apres la pub).
// Supporte:
// 1. Lien Work.ink direct (WORKINK_LINK_URL ou WORKINK_LINK_ENDPOINT = https://work.ink/...)
//    -> Utilise l'API officielle Work.ink Override (GET https://work.ink/_api/v2/override?destination=...)
// 2. Point d'entree Link API personnalise
//    -> POST vers l'endpoint avec headers et API key
async function createMonetizedLink({ durationHours: hours, puid }) {
  const reason = unavailableReason();
  if (reason) {
    throw providerError(
      reason === 'missing_link_endpoint'
        ? 'Work.ink link or API endpoint missing (set WORKINK_LINK_URL or WORKINK_LINK_ENDPOINT in Render).'
        : 'Work.ink API key missing (set WORKINK_API_KEY in Render).',
      reason
    );
  }
  if (typeof puid !== 'string' || !puid) throw providerError('missing session id', 'bad_request');

  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const destination = `${base}/api/workink/postback?puid=${encodeURIComponent(puid)}&hash={TOKEN}`;

  const endpoint = linkEndpoint();
  const isDirectWorkinkLink = /^https?:\/\/(?:[a-z0-9-]+\.)?work\.ink\//i.test(endpoint);

  // Cas 1: Lien direct Work.ink (ou dashboard) -> API officielle Override de Work.ink
  if (isDirectWorkinkLink) {
    try {
      const overrideUrl = `https://work.ink/_api/v2/override?destination=${encodeURIComponent(destination)}`;
      const res = await fetch(overrideUrl, {
        headers: { 'User-Agent': 'KeySystem/1.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.sr) {
        const sep = endpoint.includes('?') ? '&' : '?';
        const finalUrl = `${endpoint}${sep}sr=${encodeURIComponent(data.sr)}`;
        return {
          lootUrl: finalUrl,
          tasksRequired: ADS_PER_KEY,
          ads: ADS_PER_KEY,
          durationHours: hours || durationHours(),
        };
      }
    } catch (e) {
      console.warn('[workink] override API error, falling back to endpoint call:', e.message);
    }
  }

  // Cas 2: Endpoint personnalise
  const apiKey = optionalSecret('WORKINK_API_KEY');
  const headers = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['X-Api-Key'] = apiKey;
  }

  const { status, data, text } = await httpPostJson(endpoint, { destination }, headers);

  const url = extractLinkUrl(data);
  if (!url) {
    // Si c'etait un lien direct work.ink dont l'override a failli, on attache le puid en fallback
    if (isDirectWorkinkLink) {
      const sep = endpoint.includes('?') ? '&' : '?';
      return {
        lootUrl: `${endpoint}${sep}puid=${encodeURIComponent(puid)}`,
        tasksRequired: ADS_PER_KEY,
        ads: ADS_PER_KEY,
        durationHours: hours || durationHours(),
      };
    }
    const realError =
      (typeof data === 'string' && data) ||
      (data && typeof data.message === 'string' && data.message) ||
      (data && typeof data.error === 'string' && data.error) ||
      (text && text.slice(0, 100)) ||
      `unexpected response (HTTP ${status})`;
    throw providerError(realError, 'bad_response');
  }

  return { lootUrl: url, tasksRequired: ADS_PER_KEY, ads: ADS_PER_KEY, durationHours: hours || durationHours() };
}

// Verifie un token de completion aupres de l'API officielle Work.ink.
// usage unique: deleteToken=1 supprime le token apres verification (rejeu
// impossible, meme en cas de double livraison reseau).
async function verifyKeyToken(token, { singleUse = true } = {}) {
  if (typeof token !== 'string' || !token || token.length > 128) {
    return { valid: false, reason: 'malformed_token' };
  }
  const suffix = singleUse ? '?deleteToken=1' : '';
  const url = `${verifyUrl()}/${encodeURIComponent(token)}${suffix}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json().catch(() => ({}));
    if (data && typeof data.valid === 'boolean') {
      return { valid: data.valid === true, deleted: data.deleted === true, info: data.info || null };
    }
    return { valid: false, reason: `unexpected_response_${res.status}` };
  } catch (e) {
    // Panne reseau/API: on REFUSE (jamais de cle delivree sans preuve).
    return { valid: false, reason: 'verification_unavailable' };
  }
}

// Porte d'entree supplementaire: si WORKINK_POSTBACK_SECRET est configure, il
// DOIT etre present dans l'URL de retour (comparaison a temps constant).
function verifyPostbackSecret(provided) {
  const expected = postbackSecret();
  if (!expected) return { ok: true, configured: false };
  return { ok: safeEqual(String(provided || ''), expected), configured: true };
}

module.exports = {
  createMonetizedLink,
  verifyKeyToken,
  verifyPostbackSecret,
  postbackSecret,
  durationHours,
  isConfigured,
  unavailableReason,
  linkEndpoint,
  verifyUrl,
  ADS_PER_KEY,
  DEFAULT_DURATION_HOURS,
};
