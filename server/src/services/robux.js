// Service paiement Robux — client API Roblox avec cache/retries/audit
//
// APIs utilisees (doc brief):
//  - POST users.roblox.com/v1/usernames/users  (OFFICIELLE: pseudo -> userId)
//  - GET  inventory.roblox.com/v1/users/{id}/items/1/{passId}
//    (non officielle: itemType 1 = GamePass; 200=possede, 404=non, 429=rate limit)
//
// Anti-abus (brief securite):
//  - jamais de regex seule: le pseudo est TOUJOURS resolu par l'API officielle
//    (homoglyphes/usurpation impossibles)
//  - cache court du resultat d'ownership (45s) pour absorber le polling
//  - retry avec backoff exponentiel sur 429
//  - log brut des reponses API pour audit (table robux_api_logs)

const pool = require('../db');

// ===== Offres (prix hardcodes — brief: "NE PAS interroger d'API de prix") =====
// Les gamepass_id sont configures via .env (ROBUX_PASS_DAY1 etc.)
// Roblox prend ~30%: prix affiche = ce que paye l'acheteur.
function getOffers() {
  return [
    {
      sku: 'day1',
      name: '1 Day',
      durationHours: 24,
      priceR$: 50,
      gamepassId: process.env.ROBUX_PASS_DAY1 ? parseInt(process.env.ROBUX_PASS_DAY1, 10) : null,
    },
    {
      sku: 'week1',
      name: '7 Days',
      durationHours: 24 * 7,
      priceR$: 200,
      gamepassId: process.env.ROBUX_PASS_WEEK1 ? parseInt(process.env.ROBUX_PASS_WEEK1, 10) : null,
    },
    {
      sku: 'month1',
      name: '30 Days',
      durationHours: 24 * 30,
      priceR$: 500,
      gamepassId: process.env.ROBUX_PASS_MONTH1 ? parseInt(process.env.ROBUX_PASS_MONTH1, 10) : null,
    },
    {
      sku: 'lifetime',
      name: 'Lifetime',
      durationHours: 24 * 365 * 100, // ~100 ans: lifetime pratique
      priceR$: 1500,
      gamepassId: process.env.ROBUX_PASS_LIFETIME ? parseInt(process.env.ROBUX_PASS_LIFETIME, 10) : null,
    },
  ];
}

function getOfferBySku(sku) {
  return getOffers().find((o) => o.sku === sku) || null;
}

// Mapping product_id (Option B) -> offre
// Les Developer Products Roblox ont des IDs NUMERIQUES: configures via
// ROBUX_PRODUCT_DAY1 etc. (ex: 123456789). Fallback par SKU string pour les tests.
function getOfferByProductId(productId) {
  const numeric = parseInt(productId, 10);
  const map = {
    [process.env.ROBUX_PRODUCT_DAY1 || 'prod-day1']: 'day1',
    [process.env.ROBUX_PRODUCT_WEEK1 || 'prod-week1']: 'week1',
    [process.env.ROBUX_PRODUCT_MONTH1 || 'prod-month1']: 'month1',
    [process.env.ROBUX_PRODUCT_LIFETIME || 'prod-lifetime']: 'lifetime',
  };
  const sku = map[String(productId)] || map[String(numeric)];
  return sku ? getOfferBySku(sku) : null;
}

// Normalise un product_id pour stockage BIGINT: numerique valide, sinon NULL.
function normalizeProductId(productId) {
  const n = parseInt(productId, 10);
  return Number.isFinite(n) ? n : null;
}

// ===== Audit log =====
async function logApi(endpoint, userId, status, raw) {
  try {
    await pool.query(
      'INSERT INTO robux_api_logs (endpoint, user_id, status, raw) VALUES ($1, $2, $3, $4)',
      [endpoint, userId || null, status || null, String(raw || '').slice(0, 500)]
    );
  } catch {
    /* l'audit ne doit jamais casser la requete */
  }
}

// ===== Pseudo -> userId (API officielle users.roblox.com) =====
async function resolveUsername(username) {
  if (typeof username !== 'string' || username.length < 3 || username.length > 32) {
    return { found: false, reason: 'invalid_username' };
  }
  try {
    const res = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    await logApi('users.roblox.com/v1/usernames/users', null, res.status, JSON.stringify(data).slice(0, 300));
    if (res.status === 429) {
      // Rate limit Roblox: reponse RETRYABLE (pas un "not_found" — l'utilisateur legitime
      // ne doit jamais voir "compte inexistant" a cause d'un 429)
      return { found: false, reason: 'rate_limited', retryable: true };
    }
    if (!res.ok) return { found: false, reason: 'roblox_api_error_' + res.status, retryable: res.status >= 500 };
    const user = data?.data?.[0];
    if (!user || !user.id) return { found: false, reason: 'not_found' };
    return { found: true, userId: parseInt(user.id, 10), username: user.name, displayName: user.displayName };
  } catch (e) {
    return { found: false, reason: 'network_error' };
  }
}

// ===== Ownership gamepass (inventory.roblox.com — NON OFFICIELLE, gestion robuste) =====
// Cache memoire 45s par (userId, gamepassId) — absorbe le polling du front.
const ownCache = new Map();
const OWN_TTL_MS = 45 * 1000;

async function checkGamepassOwnership(userId, gamepassId, attempt = 0) {
  const cacheKey = `${userId}:${gamepassId}`;
  const cached = ownCache.get(cacheKey);
  if (cached && Date.now() - cached.t < OWN_TTL_MS) {
    return cached.v;
  }

  const url = `https://inventory.roblox.com/v1/users/${userId}/items/1/${gamepassId}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'KeySystem/1.0', Accept: 'application/json' },
    });
    await logApi('inventory.roblox.com/items/1/' + gamepassId, userId, res.status, res.status === 200 ? 'owned' : '');

    if (res.status === 200) {
      // REEL (verifie en live): l'endpoint renvoie une LISTE paginee:
      //   200 + data: []  -> NON possede
      //   200 + data:[...] -> possede
      const body = await res.json().catch(() => null);
      const owned = Array.isArray(body?.data) ? body.data.length > 0 : !!body?.userId;
      await logApi('inventory.roblox.com/items/1/' + gamepassId, userId, 200, owned ? 'owned' : 'not_owned(data empty)');
      const result = { owned, body: null };
      ownCache.set(cacheKey, { t: Date.now(), v: result });
      return result;
    }
    if (res.status === 404) {
      const result = { owned: false, reason: 'not_owned' };
      ownCache.set(cacheKey, { t: Date.now(), v: result });
      return result;
    }
    if (res.status === 429 && attempt < 2) {
      // rate limit Roblox: backoff exponentiel (brief: "retry avec backoff")
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt) + Math.random() * 300));
      return checkGamepassOwnership(userId, gamepassId, attempt + 1);
    }
    return { owned: false, reason: 'api_' + res.status, retryable: res.status === 429 || res.status >= 500 };
  } catch (e) {
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 500));
      return checkGamepassOwnership(userId, gamepassId, attempt + 1);
    }
    return { owned: false, reason: 'network_error', retryable: true };
  }
}

module.exports = { getOffers, getOfferBySku, getOfferByProductId, normalizeProductId, resolveUsername, checkGamepassOwnership, logApi };
