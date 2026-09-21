#!/usr/bin/env node
/* ============================================================================
   backup-db.js — sauvegarde COMPLETE des donnees, sans pg_dump.

   POURQUOI CE SCRIPT EXISTE
   pg_dump n'est pas installe sur le poste, et la base gratuite peut etre
   suspendue a tout moment (quota de calcul epuise): quand c'est le cas, plus
   aucune connexion n'est possible, donc plus aucune sauvegarde. La sauvegarde
   doit donc pouvoir se faire depuis le projet, en Node, avec les seules
   dependances deja presentes (pg).

   CE QU'IL FAIT
     - lit la liste des tables du schema public (aucune liste codee en dur:
       une table ajoutee plus tard est sauvegardee automatiquement);
     - ecrit un fichier JSON par table (donnees brutes, aucun format exotique);
     - ecrit manifest.json: comptes de lignes, tailles, empreintes sha256,
       et les empreintes des fichiers de schema du depot;
     - n'ecrit RIEN en base: uniquement des SELECT.

   RESTAURATION
     npm run migrate           -> recree le schema
     node scripts/restore-db.js <dossier> --write  -> reinjecte les donnees

   ATTENTION: script_versions.original_enc est CHIFFRE (AES-256-GCM). Les
   originaux ne sont lisibles qu'avec la MEME AES_KEY: conservez cette variable
   avec la sauvegarde, sinon les originaux restent illisibles pour toujours.

   Usage:
     node scripts/backup-db.js [dossier-de-sortie]
   Defaut: <Documents>/keysystem-backups/<horodatage>/  (HORS du depot git)
   ========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const nodeCrypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { sslOptions, urlSansSslmode } = require('../src/db-ssl');

const ORDRE_TABLES = `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name`;

function empreinte(txt) {
  return nodeCrypto.createHash('sha256').update(txt).digest('hex').slice(0, 16);
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL absent: impossible de sauvegarder.');
    process.exit(1);
  }

  const defaut = path.join(__dirname, '..', '..', '..', 'keysystem-backups');
  const racine = process.argv[2] || defaut;
  const horodatage = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const dossier = path.join(racine, horodatage);
  fs.mkdirSync(path.join(dossier, 'data'), { recursive: true });

  const client = new Client({
    // urlSansSslmode + sslOptions: le `sslmode` de l'URL ecraserait l'option
    // `ssl` (et vaut aujourd'hui `verify-full`), ce qui casse la connexion chez
    // un hebergeur dont l'autorite est privee (Aiven) en SELF_SIGNED_CERT_IN_CHAIN.
    connectionString: urlSansSslmode(process.env.DATABASE_URL),
    ssl: sslOptions(process.env.DATABASE_URL),
  });

  const manifest = {
    creeLe: new Date().toISOString(),
    baseDeDonnees: (process.env.DATABASE_URL.split('/').pop() || '').split('?')[0],
    avertissement:
      'script_versions.original_enc est chiffre (AES-256-GCM): les originaux exigent la MEME AES_KEY que celle utilisee lors de la sauvegarde.',
    schema: {},
    tables: {},
  };

  try {
    await client.connect();

    // Empreintes des fichiers de schema du depot (source de verite du schema).
    const dbDir = path.join(__dirname, '..', 'db');
    for (const f of fs.readdirSync(dbDir).filter((f) => f.endsWith('.sql')).sort()) {
      const contenu = fs.readFileSync(path.join(dbDir, f), 'utf8');
      manifest.schema[f] = { octets: contenu.length, sha256: empreinte(contenu) };
    }
    if (process.env.AES_KEY) {
      // On ne stocke JAMAIS la cle: seulement une empreinte, pour verifier plus
      // tard qu'une restauration utilise bien la meme cle.
      manifest.aesKeyEmpreinte = empreinte(`keysystem:aes:${process.env.AES_KEY}`);
    }

    const { rows: tables } = await client.query(ORDRE_TABLES);
    if (!tables.length) {
      console.error('Aucune table trouvee: rien a sauvegarder.');
      process.exit(1);
    }

    console.log(`[backup] ${tables.length} tables -> ${path.relative(process.cwd(), dossier)}`);
    let total = 0;
    for (const { table_name: table } of tables) {
      const { rows } = await client.query(`SELECT * FROM "${table}"`);
      const json = JSON.stringify(rows);
      fs.writeFileSync(path.join(dossier, 'data', `${table}.json`), json);
      manifest.tables[table] = { lignes: rows.length, octets: Buffer.byteLength(json), sha256: empreinte(json) };
      total += rows.length;
      console.log(`  ${table.padEnd(22)} ${String(rows.length).padStart(6)} lignes`);
    }

    const taille = (await client.query('SELECT pg_size_pretty(pg_database_size(current_database())) t')).rows[0].t;
    manifest.tailleBase = taille;
    manifest.totalLignes = total;
    fs.writeFileSync(path.join(dossier, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log(`[backup] ${total} lignes sauvegardees · base ${taille} · manifest.json ecrit`);
    console.log(`[backup] dossier: ${dossier}`);
    await client.end();
  } catch (e) {
    console.error('[backup] ECHEC:', e.message);
    await client.end().catch(() => {});
    process.exit(1);
  }
})();
