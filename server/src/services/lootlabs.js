// ============================================================================
// LootLabs -- regie publicitaire n1, DEUX paliers:
//     1 publicite  -> cle de 12 h (LOOTLABS_DURATION_HOURS)
//     2 publicites -> cle de 24 h (LOOTLABS_DURATION_HOURS_2)
// ----------------------------------------------------------------------------
// Ce que dit la documentation officielle PUBLIQUE (relue en ligne, HTTP 200):
//   https://help.lootlabs.gg/en/article/lootlabs-api-documentation-1k0hn73
//   https://help.lootlabs.gg/en/article/how-do-i-create-lootlabs-links-152r6am
//   https://help.lootlabs.gg/en/article/postback-api-1ndz3i2
//
//   1. POST https://creators.lootlabs.gg/api/public/content_locker
//      number_of_tasks | "The max number of ads associated with the link
//      shortener in a given session." | Mandatory | "Numeric value between 1
//      and 5."
//      Le panneau decrit le meme reglage: "Number of tasks: How many ad tasks
//      you [have] on the page (1-5)".
//      => C'EST le champ qui fixe le nombre de publicites d'un palier. Il est
//         envoye tel quel: palier "2 pubs" => number_of_tasks = 2.
//
//   2. tier_id | "The tier of the advertisements shown." (1 Trending &
//      Recommended / 2 Gaming Offers & Recommendations / 3 Profit
//      Maximization / 4 Maximum Profit). C'est une CATEGORIE d'annonces, PAS
//      un nombre de publicites: LOOTLABS_TIER choisit la qualite des annonces
//      et ne sert JAMAIS a decider combien de pubs (ni quelle duree).
//
//   3. Postback | "Every time a user completes a task, a GET Request will be
//      sent to your postback URL route", avec un unique_id "for each completed
//      task". Une publicite terminee = un postback avec un identifiant neuf.
//      => le nombre de pubs REELLEMENT terminees est comptable cote serveur
//         (postbacks distincts), il n'est jamais suppose.
//
// Verrou anti-derive: ce service ne fabrique JAMAIS un couple
// (nombre de pubs, duree) de facon implicite (une duree qui devinerait le
// nombre de pubs, ou l'inverse). Un palier inconnu ou desactive est refuse
// AVANT tout appel reseau, avec une raison explicite -- jamais un 500.
// ============================================================================

const LOOTLABS_ENDPOINT = 'https://creators.lootlabs.gg/api/public/content_locker';

// Un palier = un nombre de publicites (number_of_tasks) et une duree de cle.
// La duree reste surchargeable par variable d'environnement dediee.
const AD_TIERS = {
  1: { ads: 1, envVar: 'LOOTLABS_DURATION_HOURS', defaultHours: 12 },
  2: { ads: 2, envVar: 'LOOTLABS_DURATION_HOURS_2', defaultHours: 24 },
};

// Bornes documentees de number_of_tasks (doc officielle: 1 a 5).
const MIN_TASKS = 1;
const MAX_TASKS = 5;
const MAX_DURATION_HOURS = 24 * 30;

// Duree par defaut du palier historique (1 publicite): conservee a l'identique
// pour les appelants qui ne precisent aucun palier.
const DEFAULT_DURATION_HOURS = AD_TIERS[1].defaultHours;

// Palier "2 publicites": actif par defaut (la correspondance
// number_of_tasks = nombre de pubs est documentee, voir en-tete). Un seul mot
// suffit a le retirer du site: LOOTLABS_TIER2_ENABLED=false -> la carte est
// annoncee indisponible (raison tier_disabled) et /api/key/start la refuse
// proprement, sans jamais toucher au palier 1 pub.
function tier2Enabled() {
  const valeur = (process.env.LOOTLABS_TIER2_ENABLED || '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(valeur);
}

function adTier(ads) {
  const n = Number(ads);
  return Number.isInteger(n) && Object.prototype.hasOwnProperty.call(AD_TIERS, n) ? AD_TIERS[n] : null;
}

// Paliers connus, du plus petit au plus grand (source de verite unique).
function adCounts() {
  return Object.keys(AD_TIERS)
    .map(Number)
    .sort((a, b) => a - b);
}

// Duree du palier: variable d'environnement dediee, sinon valeur par defaut.
function durationHours(ads = 1) {
  const tier = adTier(ads) || AD_TIERS[1];
  const valeur = parseInt(process.env[tier.envVar] || '', 10);
  return Number.isFinite(valeur) && valeur > 0 && valeur <= MAX_DURATION_HOURS ? valeur : tier.defaultHours;
}

// null = palier disponible. Sinon la raison EXACTE (transmise telle quelle au
// front, qui masque la carte correspondante).
function unavailableReason(ads) {
  const tier = adTier(ads);
  if (!tier) return 'unknown_ads_count';
  if (tier.ads > 1 && !tier2Enabled()) return 'tier_disabled';
  return null;
}

function isAvailable(ads) {
  return unavailableReason(ads) === null;
}

// Erreur metier explicite: la route renvoie un message lisible, jamais un 500.
function providerError(message, reason) {
  const err = new Error(`LootLabs: ${message}`);
  err.lootlabsMessage = message;
  err.reason = reason;
  return err;
}

function httpPostJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  });
}

// Cree un lien LootLabs vers le callback avec le puid attache.
// ads = nombre de publicites du palier (1 ou 2): c'est LUI qui part dans
// number_of_tasks, et c'est lui que le postback devra confirmer cote serveur.
async function createMonetizedLink({ ads, durationHours: hours, puid }) {
  const demande = ads === undefined || ads === null ? 1 : Number(ads);
  const raison = unavailableReason(demande);
  if (raison) {
    throw providerError(
      raison === 'tier_disabled'
        ? `the ${demande}-ad tier is disabled (set LOOTLABS_TIER2_ENABLED=true to enable it)`
        : `unsupported ad tier (${demande} ads): expected ${adCounts().join(' or ')}`,
      raison
    );
  }
  const tier = adTier(demande);
  const duree = Number(hours) > 0 ? Number(hours) : durationHours(tier.ads);

  const callbackUrl = `${process.env.PUBLIC_URL}/getkey/callback`;

  const { status, data } = await httpPostJson(
    LOOTLABS_ENDPOINT,
    {
      title: 'Script Access Key',
      url: callbackUrl,
      tier_id: parseInt(process.env.LOOTLABS_TIER || '2', 10),
      // Nombre de publicites du palier (doc officielle: "number_of_tasks", 1-5).
      number_of_tasks: tier.ads,
      theme: parseInt(process.env.LOOTLABS_THEME || '1', 10),
    },
    { Authorization: `Bearer ${process.env.LOOTLABS_API_KEY}` }
  );

  // Validation stricte de la reponse LootLabs
  // Format reel observe: {"type":"created","message":[{"short":"...","loot_url":"https://..."}]}
  // Doc officielle: message = objet. On gere les deux.
  const raw = data && data.message;
  const msg = Array.isArray(raw) ? raw[0] : raw;
  const lootUrlRaw = msg && typeof msg.loot_url === 'string' ? msg.loot_url : null;
  if (!lootUrlRaw || !lootUrlRaw.startsWith('http')) {
    const realError =
      (typeof raw === 'string' && raw) ||
      (msg && typeof msg.message === 'string' && msg.message) ||
      `reponse inattendue (HTTP ${status})`;
    const err = new Error(`LootLabs: ${realError}`);
    err.lootlabsMessage = realError;
    err.reason = 'bad_response';
    throw err;
  }

  // Ajoute le puid pour le postback anti-bypass
  const lootUrl = `${lootUrlRaw}&puid=${puid}`;
  // tasksRequired = nombre de postbacks exiges avant la cle: EXACTEMENT le
  // nombre de publicites du palier (aucun arrondi, aucune deduction).
  return { lootUrl, ads: tier.ads, tasksRequired: tier.ads, durationHours: duree };
}

module.exports = {
  createMonetizedLink,
  AD_TIERS,
  adCounts,
  adTier,
  durationHours,
  unavailableReason,
  isAvailable,
  tier2Enabled,
  MIN_TASKS,
  MAX_TASKS,
  DEFAULT_DURATION_HOURS,
};
