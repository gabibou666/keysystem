// Diagnostic: la pub a-t-elle genere un postback?
require('dotenv').config();
const pool = require('./src/db');

async function main() {
  const sess = await pool.query(
    `SELECT s.id, s.puid, s.tasks_required, s.tasks_done, s.status, s.created_at, s.completed_at,
            (k.id IS NOT NULL) AS has_key
     FROM ll_sessions s LEFT JOIN keys k ON k.id = s.key_id
     ORDER BY s.created_at DESC LIMIT 5`
  );
  console.log('=== DERNIERES SESSIONS ===');
  sess.rows.forEach((s) => {
    console.log(
      `#${s.id} puid=${s.puid.slice(0, 8)}... req=${s.tasks_required} done=${s.tasks_done} status=${s.status} cle=${s.has_key} cree=${new Date(s.created_at).toLocaleString('fr-FR')}`
    );
  });

  const pb = await pool.query('SELECT COUNT(*)::int c FROM postbacks');
  console.log('\n=== POSTBACKS RECUS: ' + pb.rows[0].c + ' ===');
  if (pb.rows[0].c > 0) {
    const last = await pool.query('SELECT * FROM postbacks ORDER BY created_at DESC LIMIT 5');
    last.rows.forEach((p) => console.log(`puid=${p.puid.slice(0, 8)}... unique=${p.unique_id} ip=${p.ip} le=${new Date(p.created_at).toLocaleString('fr-FR')}`));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
