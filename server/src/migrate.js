require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resoudreUrl } = require('../scripts/lib-db-url');
const { sslOptions, urlSansSslmode } = require('./db-ssl');

// ============================================================================
// Application du schema COMPLET sur la base cible.
//
// BUG CORRIGE ICI: ce script n'appliquait que db/schema.sql, qui ne cree que
// 11 des 21 tables du projet. Les 10 autres sont dans db/migration-*.sql
// (beacons, discord_joins, game_info, game_statuses, referrals,
// referral_rewards, robux_api_logs, robux_purchases, robux_receipts,
// user_cache). Recreer une base (nouvel hebergeur, restauration d'une
// sauvegarde) produisait donc un schema INCOMPLET: la restauration echouait en
// cours de route, ou l'application tournait avec des tables manquantes.
//
// Cible: server/.env.migration si present (migration vers un autre hebergeur),
// sinon DATABASE_URL de .env. L'URL est toujours affichee masquee.
//
// Usage: npm run migrate [-- --dry-run]
// ============================================================================

const DRY = process.argv.includes('--dry-run');
const dbDir = path.join(__dirname, '..', 'db');

// Tous les fichiers de schema, dans un ordre deterministe: schema.sql d'abord
// (tables de base), puis les migrations par ordre alphabetique.
const fichiers = [
  'schema.sql',
  ...fs
    .readdirSync(dbDir)
    .filter((f) => /^migration-.*\.sql$/i.test(f))
    .sort(),
];

// Un schema deja en place ne doit pas faire echouer la migration: les fichiers
// ne sont pas tous idempotents (CREATE TABLE / ADD COLUMN sans IF NOT EXISTS).
const DEJA_APPLIQUE = new Set(['42P07', '42701', '42710', '42P16', '42723', '42P06']);

async function migrate() {
  const cible = resoudreUrl({ cibleMigration: true });
  console.log(`[migrate] cible: ${cible.cible} (source ${cible.source})`);
  console.log(`[migrate] ${fichiers.length} fichiers a appliquer`);

  if (DRY) {
    for (const f of fichiers) console.log(`  - ${f}`);
    console.log('[migrate] --dry-run: aucune ecriture.');
    return;
  }

  const pool = new Pool({
    connectionString: urlSansSslmode(cible.url),
    ssl: sslOptions(cible.url),
  });

  try {
    for (const f of fichiers) {
      const sql = fs.readFileSync(path.join(dbDir, f), 'utf8');
      try {
        await pool.query(sql);
        console.log(`  ✅ ${f}`);
      } catch (e) {
        if (DEJA_APPLIQUE.has(e.code)) {
          console.log(`  ⤵️  ${f} (deja applique)`);
        } else {
          throw new Error(`${f}: ${e.message}`);
        }
      }
    }
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"
    );
    console.log(`[migrate] ${rows.length} tables presentes: ${rows.map((r) => r.tablename).join(', ')}`);
    if (rows.length < 21) {
      console.log('[migrate] ATTENTION: moins de 21 tables attendues — verifier db/*.sql');
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

migrate().catch((e) => {
  console.error('[migrate] ERREUR:', e.message);
  process.exit(1);
});
