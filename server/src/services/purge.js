// Purge automatique des logs operationnels — evite que les tables croissent
// a l'infini et ralentissent le systeme de cles (l'utilisateur voit ses
// verification de cle de plus en plus lentes au fil des mois).
// Sessions/postbacks/beacons/errors > 30j, executions/activations > 90j.
// Cadence: au demarrage puis toutes les 24h.

// NOTE: les compteurs publics (/api/stats/public) comptent les executions
// actives — apres purge ils refletent une fenetre glissante de 90 jours
// (choix assume: chiffres honnetes sur l'activite reelle recente).

const pool = require('../db');

const INTERVALS = {
  ll_sessions: '30 days',
  postbacks: '30 days',
  // Beacons 90j: alignes sur executions pour que l'investigation watermark
  // (admin /watermark/decode) garde la meme fenetre que les executions.
  beacons: '90 days',
  error_reports: '30 days',
  robux_api_logs: '30 days',
  // Sessions admin expirees depuis longtemps (le check d'expiration se fait
  // de toute facon a chaque utilisation du token, on purge juste les lignes).
  admin_sessions: '30 days',
  executions: '90 days',
  activations: '90 days',
};

async function purgeNow() {
  const results = {};
  for (const [table, interval] of Object.entries(INTERVALS)) {
    try {
      const r = await pool.query(
        `DELETE FROM ${table} WHERE created_at < now() - interval '${interval}'`
      );
      if (r.rowCount > 0) results[table] = r.rowCount;
    } catch (e) {
      console.error(`[purge] ${table}:`, e.message);
    }
  }
  const purged = Object.values(results).reduce((a, b) => a + b, 0);
  if (purged > 0) console.log(`[purge] ${purged} vieux enregistrements supprimes:`, results);
  return results;
}

function startPurgeScheduler() {
  // Premiere passe au demarrage (laisse le serveur ecouter d'abord)
  setTimeout(() => purgeNow().catch(() => {}), 15 * 1000).unref();
  // Puis quotidiennement
  setInterval(() => purgeNow().catch(() => {}), 24 * 60 * 60 * 1000).unref();
  console.log('[purge] planificateur actif (30j sessions/logs, 90j executions)');
}

module.exports = { purgeNow, startPurgeScheduler, INTERVALS };
