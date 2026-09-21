#!/usr/bin/env node
/* ============================================================================
   verify-db.js — confronte une base VIVANTE a une sauvegarde.

   A quoi ca sert: apres une restauration ou une migration, "le script s'est bien
   termine" ne prouve rien. On compare donc ligne a ligne et table par table ce
   qui est en base avec ce que contient la sauvegarde, via des empreintes
   independantes de l'ordre de lecture (tableau trie avant hachage) — un simple
   comptage laisserait passer des lignes remplacees par d'autres.

   Verifie aussi:
     - les scripts chiffres: dechiffrables avec la cle en service, empreinte
       SHA-256 conforme a celle stockee (une migration reussie mais un AES_KEY
       different = originaux perdus);
     - les sequences: recalibrees apres restauration (sinon la premiere cle
       creee entre en conflit avec un id deja present).

   Usage: node scripts/verify-db.js <dossier-backup>
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { Client } = require('pg');
const { resoudreUrl } = require('./lib-db-url');
const { sslOptions, urlSansSslmode } = require('../src/db-ssl');

const dossier = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!dossier) {
  console.error('Usage: node scripts/verify-db.js <dossier-backup>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dossier, 'manifest.json'), 'utf8'));
const empreinte = (liste) => nodeCrypto.createHash('sha256').update(liste.join('\n')).digest('hex').slice(0, 16);

// Colonne identifiante pour produire une empreinte comparable.
const CLE = { keys: 'kid', script_versions: 'version', script_builds: 'version', game_info: 'place_id' };
const colonneCle = (table, ligne) => CLE[table] || (ligne.id !== undefined ? 'id' : Object.keys(ligne)[0]);

const resultats = [];
const planter = [];

(async () => {
  const cible = resoudreUrl({ cibleMigration: true });
  console.log(`[verify] base   : ${cible.cible} (source ${cible.source})`);
  console.log(`[verify] sauvegarde: ${manifest.creeLe} · ${Object.keys(manifest.tables).length} tables\n`);

  const client = new Client({ connectionString: urlSansSslmode(cible.url), ssl: sslOptions(cible.url) });
  await client.connect();

  try {
    const resume = [];
    for (const [table, meta] of Object.entries(manifest.tables)) {
      const lignesBackup = JSON.parse(fs.readFileSync(path.join(dossier, 'data', `${table}.json`), 'utf8'));
      const col = colonneCle(table, lignesBackup[0] || {});
      const { rows } = await client.query(`SELECT count(*)::int n FROM "${table}"`);
      const enBase = rows[0].n;

      let empreinteBackup = null;
      let empreinteBase = null;
      if (lignesBackup.length) {
        empreinteBackup = empreinte(lignesBackup.map((l) => String(l[col])).sort());
        const r = await client.query(
          `SELECT md5(string_agg(x::text, E'\\n' ORDER BY x::text)) m FROM (SELECT "${col}" x FROM "${table}") s`
        );
        // md5 cote base, sha cote backup: on compare donc les LISTES, pas les hachages.
        const liste = (
          await client.query(`SELECT "${col}"::text x FROM "${table}" ORDER BY "${col}"::text`)
        ).rows.map((r2) => r2.x);
        empreinteBase = empreinte(liste);
      } else {
        empreinteBackup = empreinte([]);
        empreinteBase = empreinte([]);
      }

      const ok = enBase === lignesBackup.length && empreinteBase === empreinteBackup;
      resultats.push({ table, attendu: lignesBackup.length, enBase, ok });
      if (!ok) planter.push(`${table}: ${enBase} en base / ${lignesBackup.length} attendu, empreinte ${ok ? '' : 'DIFFERENTE'}`);
      resume.push(`  ${ok ? '✓' : '✗'} ${table.padEnd(20)} ${String(enBase).padStart(6)} lignes`);
    }
    console.log(resume.join('\n'));

    // ---- Scripts chiffres: lisibles avec la cle en service ? ----
    let { decryptAES, sha256 } = { decryptAES: null, sha256: null };
    try {
      ({ decryptAES, sha256 } = require('../src/services/crypto'));
      const { rows } = await client.query(
        'SELECT version, original_enc, original_iv, original_hash FROM script_versions ORDER BY version'
      );
      let ok = 0;
      for (const r of rows) {
        const clair = decryptAES(r.original_enc, r.original_iv);
        if (!r.original_hash || sha256(clair) === r.original_hash) ok++;
        else planter.push(`script v${r.version}: empreinte differente apres dechiffrement`);
      }
      console.log(`\n  ${ok === rows.length ? '✓' : '✗'} scripts chiffres: ${ok}/${rows.length} dechiffrables et conformes`);
      if (ok !== rows.length) planter.push('originaux chiffres non conformes');
    } catch (e) {
      planter.push(`dechiffrement impossible: ${e.message}`);
      console.log(`\n  ✗ dechiffrement: ${e.message}`);
    }

    // ---- Sequences recalibrees ? ----
    const seq = await client.query(
      "SELECT sequencename, last_value FROM pg_sequences WHERE schemaname='public' ORDER BY 1"
    );
    const enRetard = [];
    for (const s of seq.rows) {
      const table = s.sequencename.replace(/_id_seq$/, '');
      try {
        const max = (await client.query(`SELECT coalesce(max(id),0)::bigint m FROM "${table}"`)).rows[0].m;
        if (BigInt(s.last_value ?? 0) < BigInt(max)) enRetard.push(`${table} (sequence ${s.last_value} < max id ${max})`);
      } catch {
        /* table sans colonne id */
      }
    }
    console.log(`  ${enRetard.length ? '✗' : '✓'} sequences: ${enRetard.length ? enRetard.join(', ') : 'a jour'}`);
    if (enRetard.length) planter.push(`sequences en retard: ${enRetard.join(', ')}`);

    console.log(`\n${resultats.filter((r) => r.ok).length}/${resultats.length} tables conformes`);
    console.log(planter.length ? `ECHEC: ${planter.join(' | ')}` : '[verify] VERDICT: base conforme a la sauvegarde');
    process.exitCode = planter.length ? 1 : 0;
  } finally {
    await client.end().catch(() => {});
  }
})().catch((e) => {
  console.error('[verify] ERREUR:', e.message);
  process.exit(1);
});
