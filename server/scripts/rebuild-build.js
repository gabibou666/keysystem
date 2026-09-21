/* Regeneration d'UN build (preambule + obfuscation + validation), script par
   script, avec retour arriere possible.

   Usage:
     node scripts/rebuild-build.js 2            -> simulation, ne touche a rien
     node scripts/rebuild-build.js 2 --apply    -> enregistre le nouveau build

   Garde-fous:
   - refuse de continuer si le controll de session n'est pas dans le build genere
     (mieux vaut ne rien faire que livrer un script sans protection);
   - refuse de continuer si la validation structurelle du pipeline echoue;
   - copie le build PRECEDENT hors du depot avant de l'ecraser (retour arriere). */
'use strict';
const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
require(path.join(RACINE, 'node_modules', 'dotenv')).config({ path: path.join(RACINE, '.env') });

const { Client } = require(path.join(RACINE, 'node_modules', 'pg'));
const { sslOptions, urlSansSslmode } = require(path.join(RACINE, 'src', 'db-ssl'));
const { decryptAES } = require(path.join(RACINE, 'src', 'services', 'crypto'));
const pipeline = require(path.join(RACINE, 'src', 'compat', 'pipeline'));

const runPipeline = pipeline.runPipeline || pipeline.buildScript || pipeline.build;
const SAUVEGARDES = 'C:/Users/varoq/Documents/keysystem-backups/builds';

const version = Number(process.argv[2]);
const appliquer = process.argv.includes('--apply');
const decode = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

(async () => {
  if (!version) { console.error('usage: node scripts/rebuild-build.js <version> [--apply]'); process.exit(2); }
  if (typeof runPipeline !== 'function') {
    console.error('pipeline introuvable: exports =', Object.keys(pipeline));
    process.exit(2);
  }
  const c = new Client({
    connectionString: urlSansSslmode(process.env.DATABASE_URL),
    ssl: sslOptions(process.env.DATABASE_URL),
  });
  await c.connect();

  const cols = await c.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='script_builds' ORDER BY ordinal_position"
  );
  console.log('  colonnes de script_builds : ' + cols.rows.map((r) => r.column_name).join(', '));

  const v = (await c.query(
    'SELECT id, version, place_id, original_enc, original_iv FROM script_versions WHERE version = $1',
    [version]
  )).rows[0];
  if (!v) { console.error(`  version ${version} introuvable`); await c.end(); process.exit(2); }

  const ancien = (await c.query(
    'SELECT id, build_type, octet_length(content) taille, active FROM script_builds WHERE version_id = $1 ORDER BY active DESC, id DESC LIMIT 1',
    [v.id]
  )).rows[0];
  if (!ancien) { console.error(`  aucun build existant pour la version ${version}`); await c.end(); process.exit(2); }
  console.log(`  build actuel : id=${ancien.id} type=${ancien.build_type} ${ancien.taille} octets actif=${ancien.active}`);

  const source = decryptAES(v.original_enc, v.original_iv);
  console.log(`  source dechiffree : ${source.length} octets`);

  const r = await runPipeline(source, { useAI: false });
  const nouveau = r.build || '';
  console.log(`  nouveau build : ${nouveau.length} octets (prelude ${r.preludeLength ?? '?'}, obfuscation ${r.obfuscationApplied ? 'appliquee' : 'non appliquee'}, patches ${(r.patches || []).length})`);

  // --- Garde-fous: on n'ecrit QUE si le controle de session est present -----
  const aNeutralisation = nouveau.includes('__KS_NEUTRALISER') && nouveau.includes('__KS_AVANT');
  const aPointControle = decode(nouveau).includes('/api/v1/token');
  const aSite = decode(nouveau).includes((process.env.PUBLIC_URL || '').replace(/\/+$/, ''));
  console.log(`  controle de session : neutralisation=${aNeutralisation ? 'oui' : 'NON'} point=${aPointControle ? 'oui' : 'NON'} adresse=${aSite ? 'oui' : 'NON'}`);
  if (!aNeutralisation || !aPointControle || !aSite) {
    console.error('  ABANDON: le build genere ne contient pas le controle de session complet. Rien n\'a ete modifie.');
    await c.end();
    process.exit(1);
  }

  if (!appliquer) {
    console.log('  (simulation: rien n\'a ete ecrit. Ajoute --apply pour enregistrer)');
    await c.end();
    return;
  }

  fs.mkdirSync(SAUVEGARDES, { recursive: true });
  const fichier = path.join(SAUVEGARDES, `v${version}-build-precedent-${new Date().toISOString().replace(/[:.]/g, '-')}.lua`);
  const contenuAncien = (await c.query('SELECT content FROM script_builds WHERE id = $1', [ancien.id])).rows[0].content;
  fs.writeFileSync(fichier, contenuAncien);
  console.log(`  build precedent sauvegarde : ${fichier} (${contenuAncien.length} octets)`);

  const maj = await c.query(
    'UPDATE script_builds SET content = $1, build_type = $2 WHERE id = $3 RETURNING octet_length(content) taille',
    [nouveau, r.patches && r.patches.length ? 'ai' : 'shims', ancien.id]
  );
  console.log(`  enregistre : id=${ancien.id} ${maj.rows[0].taille} octets`);

  // Relecture independante: ce qui est en base est bien ce qu'on croit.
  const relu = (await c.query('SELECT content FROM script_builds WHERE id = $1', [ancien.id])).rows[0].content;
  const conforme = relu.length === nouveau.length && relu.includes('__KS_NEUTRALISER');
  console.log(`  relecture : ${conforme ? 'conforme' : 'NON CONFORME'} (${relu.length} octets)`);
  await c.end();
  process.exit(conforme ? 0 : 1);
})().catch((e) => { console.error('  ECHEC:', e.message); process.exit(1); });
