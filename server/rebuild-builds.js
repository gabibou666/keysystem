// Rebuild le build actif avec l'obfuscateur corrigé
require('dotenv').config();
const pool = require('./src/db');
const { decryptAES, sha256 } = require('./src/services/crypto');
const { runPipeline } = require('./src/compat/pipeline');

async function main() {
  // Build actif cassé
  const active = await pool.query('SELECT id, version_id, version, place_id FROM script_builds WHERE active = true');
  for (const b of active.rows) {
    // Original déchiffré
    const ver = await pool.query('SELECT original_enc, original_iv, original_hash FROM script_versions WHERE id = $1', [b.version_id]);
    const v = ver.rows[0];
    const source = decryptAES(v.original_enc, v.original_iv);
    if (sha256(source) !== v.original_hash) throw new Error('hash mismatch pour v' + b.version);

    console.log(`Rebuild build #${b.id} (v${b.version}, place=${b.place_id || 'tous'}), original: ${source.length} chars`);

    // Nouveau pipeline
    const r = await runPipeline(source, { useAI: false });
    console.log(`  obfuscation: ${r.obfuscationApplied ? 'VALIDEE' : 'rejetee (fallback prelude+source)'}, build: ${r.build.length} chars`);

    // Remplace le contenu du build
    await pool.query('UPDATE script_builds SET content = $1 WHERE id = $2', [r.build, b.id]);
    console.log('  build remplace OK');
  }
  console.log('\nTous les builds actifs ont ete reconstruits avec l\'obfuscateur corrigé.');
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
