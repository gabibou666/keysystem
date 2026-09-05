const LOOTLABS_ENDPOINT = 'https://creators.lootlabs.gg/api/public/content_locker';

// Durees -> checkpoints (number_of_tasks LootLabs)
const DURATIONS = {
  12: { tasks: 1, label: '12 heures' },
  24: { tasks: 2, label: '24 heures' },
};

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

// Cree un lien LootLabs vers le callback avec le puid attache
async function createMonetizedLink({ durationHours, puid }) {
  const config = DURATIONS[durationHours];
  if (!config) throw new Error('Duree invalide');

  const callbackUrl = `${process.env.PUBLIC_URL}/getkey/callback`;

  const { status, data } = await httpPostJson(
    LOOTLABS_ENDPOINT,
    {
      title: 'Script Access Key',
      url: callbackUrl,
      tier_id: parseInt(process.env.LOOTLABS_TIER || '2', 10),
      number_of_tasks: config.tasks,
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
    throw err;
  }

  // Ajoute le puid pour le postback anti-bypass
  const lootUrl = `${lootUrlRaw}&puid=${puid}`;
  return { lootUrl, tasksRequired: config.tasks };
}

module.exports = { createMonetizedLink, DURATIONS };
