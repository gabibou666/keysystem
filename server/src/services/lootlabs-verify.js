// Vérification REVENU RÉEL LootLabs — Statistics API
// Doc: help.lootlabs.gg/en/article/lootlabs-statistics-api-8fdf3a
// Principe: le subid des rapports = l'identifiant d'attribution.
// On publie les liens avec puid comme subid (via l'URL &puid= de leur doc postback
// — meme valeur). Apres livraison d'une cle, on interroge les rapports du jour:
// si le puid n'apparait avec AUCUNE revenue > 0 => conversion pas encore
// encaissee => la clelivree est "a risque" (bypass possible). On log et notifie.
//
// Tolerances: la stat peut avoir du retard -> on verifie sur une fenetre de 2 jours
// et on NOTIFIE seulement (pas de blocage retroactif pour ne pas casser l'UX legitime).

const pool = require('../db');

const REPORTS_URL = 'https://creators.lootlabs.gg/api/public/reports';

async function httpGetJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'KeySystem/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('lootlabs stats ' + res.status);
  return res.json();
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Verifie une liste de sessions livrees: pour chacune, la revenue subid existe-t-elle?
// Retourne Map(puid -> revenue)
async function fetchSubidRevenue(fromDaysAgo = 2) {
  const token = process.env.LOOTLABS_API_KEY;
  if (!token) return new Map();

  // Feed IDs requis par l'API — recupere la liste d'abord
  let feeds = [];
  try {
    const f = await httpGetJson(`${REPORTS_URL}/feeds?api_token=${token}`);
    feeds = (f.feeds || []).map((x) => x._id);
  } catch {
    return new Map();
  }
  if (!feeds.length) return new Map();

  const from = ymd(new Date(Date.now() - fromDaysAgo * 86400000));
  const to = ymd(new Date());

  // group_by subid -> revenue par subid (puid)
  const out = new Map();
  for (const feed of feeds) {
    try {
      const d = await httpGetJson(
        `${REPORTS_URL}?api_token=${token}&feeds=${encodeURIComponent(feed)}&from_date=${from}&to_date=${to}&columns=total_revenue&group_by=subid`
      );
      for (const row of d?.message?.results || []) {
        const subid = row.subid;
        const rev = parseFloat(row.total_revenue || 0);
        if (subid) out.set(subid, (out.get(subid) || 0) + rev);
      }
    } catch {
      /* feed indisponible: on continue */
    }
  }
  return out;
}

// Verifie les sessions "completed" recentes: marque revenue_verified si revenue > 0,
// notifie Discord pour celles sans revenue (audit anti-bypass).
async function auditRecentSessions(notify) {
  try {
    const { rows } = await pool.query(
      `SELECT puid, ip, owner_discord_id, completed_at
       FROM ll_sessions
       WHERE status IN ('completed','claimed') AND revenue_verified = false
         AND completed_at > now() - interval '2 days'`
    );
    if (!rows.length) return { checked: 0 };

    const revMap = await fetchSubidRevenue(2);
    let verified = 0;
    const suspicious = [];

    for (const s of rows) {
      const rev = revMap.get(s.puid) || 0;
      if (rev > 0) {
        await pool.query('UPDATE ll_sessions SET revenue_verified = true WHERE puid = $1', [s.puid]);
        verified++;
      } else {
        suspicious.push(s.puid);
      }
    }

    if (suspicious.length && notify) {
      notify({
        title: '⚠️ Anti-bypass audit',
        color: 'warn',
        description: `${suspicious.length} recent session(s) delivered with NO revenue recorded on LootLabs.
Possible bypass or stats delay — review: ${suspicious.slice(0, 5).join(', ')}${suspicious.length > 5 ? '…' : ''}`,
      });
    }
    return { checked: rows.length, verified, suspicious: suspicious.length };
  } catch (e) {
    console.error('[lootlabs-verify]', e.message);
    return { checked: 0, error: e.message };
  }
}

module.exports = { auditRecentSessions, fetchSubidRevenue };
