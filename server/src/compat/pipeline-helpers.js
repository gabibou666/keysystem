// Helpers pipeline: reconstruction d'un build depuis l'original chiffre
const pool = require('../db');
const { decryptAES, sha256 } = require('../services/crypto');
const { runPipeline } = require('./pipeline');

// Reconstruit le build d'une version (id de script_versions) depuis son original
// chiffre AES et l'active. Retourne true si un build existe/est reconstruit.
async function rebuildVersionBuild(versionId) {
  const ver = await pool.query(
    'SELECT id, version, place_id, original_enc, original_iv, original_hash FROM script_versions WHERE id = $1',
    [versionId]
  );
  const v = ver.rows[0];
  if (!v || !v.original_enc) return false;

  // Verifie l'integrite de l'original avant tout
  let source;
  try {
    source = decryptAES(v.original_enc, v.original_iv);
    if (sha256(source) !== v.original_hash) return false;
  } catch {
    return false;
  }

  // Le build existe deja? on le reactive
  const existing = await pool.query(
    'SELECT id FROM script_builds WHERE version_id = $1 LIMIT 1',
    [versionId]
  );
  if (existing.rows[0]) {
    await pool.query('UPDATE script_builds SET active = true WHERE id = $1', [existing.rows[0].id]);
    return true;
  }

  // Reconstruit via le pipeline complet (prelude + obfuscation + validation)
  const r = await runPipeline(source, { useAI: false });
  await pool.query(
    `INSERT INTO script_builds (version_id, version, place_id, content, build_type, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [versionId, v.version, v.place_id, r.build, r.obfuscationApplied ? 'shims' : 'shims']
  );
  return true;
}

module.exports = { rebuildVersionBuild };
