const pool = require('../db');
const {errorSummary}=require('./private-diagnostics');

const INTERVALS = { developer_events:'90 days', developer_checkpoints:'1 day' };

async function purgeNow() {
  const results = {};
  try {const r=await pool.query("DELETE FROM developer_registration_limits WHERE window_start < now() - interval '30 days'");if(r.rowCount) results.developer_registration_limits=r.rowCount;}
  catch(e) {console.error('[purge] developer_registration_limits:',errorSummary(e));}
  for (const table of ['developer_sessions', 'developer_email_tokens', 'developer_script_metric_receipts']) {
    try { const r = await pool.query(`DELETE FROM ${table} WHERE expires_at < now()`); if (r.rowCount) results[table] = r.rowCount; }
    catch (e) { console.error(`[purge] ${table}:`, errorSummary(e)); }
  }
  try { const r = await pool.query("DELETE FROM developer_admin_sessions WHERE last_activity_at < now() - interval '2 hours'"); if (r.rowCount) results.developer_admin_sessions = r.rowCount; }
  catch (e) { console.error('[purge] developer_admin_sessions:', errorSummary(e)); }
  for (const [table, interval] of Object.entries(INTERVALS)) {
    try {
      const r = await pool.query(
        `DELETE FROM ${table} WHERE created_at < now() - interval '${interval}'`
      );
      if (r.rowCount > 0) results[table] = r.rowCount;
    } catch (e) {
      console.error(`[purge] ${table}:`, errorSummary(e));
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
  console.log('[purge] planificateur actif (developer sessions and events)');
}

module.exports = { purgeNow, startPurgeScheduler, INTERVALS };
