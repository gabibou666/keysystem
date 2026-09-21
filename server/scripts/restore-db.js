#!/usr/bin/env node
/* ============================================================================
   restore-db.js — reinjecte les donnees d'une sauvegarde creee par backup-db.js.

   Par defaut: SIMULATION (aucune ecriture) — on affiche ce qui serait insere.
   Pour ecrire vraiment: ajouter --write. Pour ecrire dans des tables qui
   contiennent deja des lignes: ajouter --force (sinon le script refuse: ecraser
   des donnees existantes doit etre un choix explicite).

   L'ordre d'insertion est calcule a partir des cles etrangeres declarees en
   base (tri topologique): sinon les contraintes refusent les lignes enfants.

   Les empreintes du manifest sont verifiees avant toute ecriture: une
   sauvegarde alteree ne doit pas etre reinjectee silencieusement.

   Usage:
     node scripts/restore-db.js <dossier-backup> [--write] [--force] [--manuel-avant]
   ========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const nodeCrypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { resoudreUrl } = require('./lib-db-url');
const { sslOptions, urlSansSslmode } = require('../src/db-ssl');

const args = process.argv.slice(2);
const dossier = args.find((a) => !a.startsWith('--'));
const ECRIRE = args.includes('--write');
const FORCER = args.includes('--force');
const MANUEL = args.includes('--manuel-avant');

if (!dossier) {
  console.error('Usage: node scripts/restore-db.js <dossier-backup> [--write] [--force]');
  process.exit(1);
}
if (!fs.existsSync(path.join(dossier, 'manifest.json'))) {
  console.error(`manifest.json introuvable dans ${dossier}`);
  process.exit(1);
}
// Cible: server/.env.migration si present (migration vers un autre hebergeur),
// sinon DATABASE_URL de .env. Jamais affichee en clair.
let cible;
try {
  cible = resoudreUrl({ cibleMigration: true });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dossier, 'manifest.json'), 'utf8'));
const empreinte = (txt) => nodeCrypto.createHash('sha256').update(txt).digest('hex').slice(0, 16);

// ---------- 1. Verifier l'integrite de la sauvegarde ----------
function chargerEtVerifier() {
  const donnees = {};
  const problemes = [];
  for (const [table, meta] of Object.entries(manifest.tables)) {
    const fichier = path.join(dossier, 'data', `${table}.json`);
    if (!fs.existsSync(fichier)) {
      problemes.push(`${table}: fichier absent`);
      continue;
    }
    const brut = fs.readFileSync(fichier, 'utf8');
    if (empreinte(brut) !== meta.sha256) {
      problemes.push(`${table}: empreinte differente du manifest (fichier altere ?)`);
      continue;
    }
    let lignes;
    try {
      lignes = JSON.parse(brut);
    } catch (e) {
      problemes.push(`${table}: JSON illisible (${e.message})`);
      continue;
    }
    if (!Array.isArray(lignes) || lignes.length !== meta.lignes) {
      problemes.push(`${table}: ${Array.isArray(lignes) ? lignes.length : '?'} lignes au lieu de ${meta.lignes}`);
      continue;
    }
    donnees[table] = lignes;
  }
  return { donnees, problemes };
}

// ---------- 2. Ordre d'insertion (dependances de cles etrangeres) ----------
function ordonner(dependantDe, tables) {
  const ordre = [];
  const vus = new Set();
  const enCours = new Set();
  const visit = (t) => {
    if (vus.has(t)) return;
    if (enCours.has(t)) return; // cycle: on tranche par ordre alphabetique
    enCours.add(t);
    for (const parent of dependantDe[t] || []) if (tables.includes(parent)) visit(parent);
    enCours.delete(t);
    vus.add(t);
    ordre.push(t);
  };
  [...tables].sort().forEach(visit);
  return ordre;
}

const TYPES_SIMPLE = (v) => v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';

(async () => {
  const { donnees, problemes } = chargerEtVerifier();
  if (problemes.length) {
    console.error('Sauvegarde NON valide:');
    problemes.forEach((p) => console.error(`  • ${p}`));
    process.exit(1);
  }
  const tables = Object.keys(donnees);
  const totalLignes = Object.values(donnees).reduce((n, r) => n + r.length, 0);
  console.log(`[restore] sauvegarde du ${manifest.creeLe} · ${tables.length} tables · ${totalLignes} lignes`);
  if (manifest.aesKeyEmpreinte && process.env.AES_KEY) {
    const meme = empreinte(`keysystem:aes:${process.env.AES_KEY}`) === manifest.aesKeyEmpreinte;
    console.log(
      meme
        ? '  AES_KEY: identique a celle de la sauvegarde (les originaux chiffres resteront lisibles)'
        : '  AES_KEY: DIFFERENTE de celle de la sauvegarde -> les originaux chiffres seront illisibles'
    );
  } else if (manifest.aesKeyEmpreinte) {
    console.log('  AES_KEY: absente ici, mais la sauvegarde en attend une (original_enc illisible sans elle)');
  }

  if (MANUEL) {
    console.log('\n[restore] --manuel-avant: aucune ecriture (mode documentaire).');
    return;
  }

  console.log(`[restore] cible: ${cible.cible} (source ${cible.source})`);
  const client = new Client({ connectionString: urlSansSslmode(cible.url), ssl: sslOptions(cible.url) });
  await client.connect();
  try {
    // La cible doit contenir TOUTES les tables de la sauvegarde. Sinon la
    // restauration echoue a mi-parcours — et un schema incomplet vient de
    // db/*.sql, pas de la sauvegarde.
    const { rows: tbl } = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'"
    );
    const presentes = new Set(tbl.map((r) => r.tablename));
    const manquantes = tables.filter((t) => !presentes.has(t));
    if (manquantes.length) {
      console.error(
        `\n[restore] ARRET: ${manquantes.length} table(s) absente(s) de la cible: ${manquantes.join(', ')}` +
          "\n          Lancer d'abord: npm run migrate  (applique schema.sql ET db/migration-*.sql)"
      );
      return;
    }

    // Dependances declarees en base (et non devinees).
    const fk = await client.query(`
      SELECT tc.table_name AS enfant, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
    const dependantDe = {};
    for (const r of fk.rows) (dependantDe[r.enfant] = dependantDe[r.enfant] || []).push(r.parent);
    const ordre = ordonner(dependantDe, tables);
    console.log(`[restore] ordre d'insertion: ${ordre.join(' -> ')}`);

    const existantes = {};
    for (const t of tables) {
      const n = (await client.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
      existantes[t] = n;
    }
    const nonVides = tables.filter((t) => existantes[t] > 0);
    if (nonVides.length && !FORCER) {
      console.error(
        `\n[restore] ARRET: ${nonVides.length} table(s) contiennent deja des lignes (${nonVides.join(', ')}).` +
          '\n          Utiliser une base vide (recommande), ou ajouter --force pour ecraser.'
      );
      return;
    }

    if (!ECRIRE) {
      console.log('\n[restore] SIMULATION (aucune ecriture). Detail:');
      for (const t of ordre) console.log(`  ${t.padEnd(22)} ${donnees[t].length} lignes a inserer`);
      console.log('\n[restore] Pour ecrire reellement: ajouter --write');
      return;
    }

    await client.query('BEGIN');
    // Insertion par LOTS: un seul INSERT multi-lignes par paquet de 200 lignes.
    // Un INSERT par ligne (3 819 allers-retours) a deja fait perdre une
    // transaction entiere: trop long, et le COMMIT peut alors s'appliquer a une
    // autre connexion sans que rien ne signale l'echec — la base reste vide
    // alors que le script annonce un succes.
    const TAILLE_LOT = 200;
    let insere = 0;
    for (const t of ordre) {
      const lignes = donnees[t];
      if (!lignes.length) continue;
      const colonnes = Object.keys(lignes[0]);
      const mauvais = lignes.find((l) => colonnes.some((c) => !TYPES_SIMPLE(l[c])));
      if (mauvais) throw new Error(`${t}: type de valeur non gere dans la sauvegarde`);
      const listeColonnes = colonnes.map((c) => `"${c}"`).join(', ');
      for (let i = 0; i < lignes.length; i += TAILLE_LOT) {
        const params = [];
        const valeurs = lignes
          .slice(i, i + TAILLE_LOT)
          .map((ligne) => `(${colonnes.map((c) => { params.push(ligne[c]); return `$${params.length}`; }).join(', ')})`)
          .join(', ');
        await client.query(`INSERT INTO "${t}" (${listeColonnes}) VALUES ${valeurs}`, params);
        insere += params.length / colonnes.length;
      }
      // Lecture de controle: ce qui compte n'est pas le nombre d'insertions
      // envoyees, mais le nombre de lignes REELLEMENT presentes.
      const n = (await client.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
      if (n !== lignes.length) throw new Error(`${t}: ${n} lignes en base apres insertion, ${lignes.length} attendues`);
      console.log(`  ${t.padEnd(22)} ${String(n).padStart(5)} lignes verifiees en base`);
    }
    await client.query('COMMIT');

    // VERIFICATION APRES COMMIT — la seule qui compte.
    // Un COMMIT sur une transaction avortee rend la main SANS erreur (Postgres se
    // contente d'un avertissement): sans cette relecture apres commit, un echec
    // total passe pour un succes. C'est exactement ce qui s'est produit ici.
    let ecarts = 0;
    for (const t of ordre) {
      const attendu = donnees[t].length;
      const n = (await client.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
      if (n !== attendu) {
        ecarts++;
        console.error(`  ✗ ${t}: ${n} lignes APRES commit, ${attendu} attendues`);
      }
    }
    if (ecarts) {
      throw new Error(
        `${ecarts} table(s) non persistees apres commit — la transaction a ete annulee (une erreur avalee suffit)`
      );
    }

    // Sequences: HORS transaction, et chaque echec est VISIBLE. Une erreur avalee
    // a l'interieur d'une transaction l'avorte entierement, sans le signaler.
    for (const t of ordre) {
      try {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT max(id) FROM "${t}"), 1))`
        );
      } catch (e) {
        console.log(`  (sequence de ${t} non recalibree: ${e.message.split('\n')[0].slice(0, 70)})`);
      }
    }

    console.log(`\n[restore] TERMINE: ${insere} lignes reinjectees ET relues apres commit (sequences recalibrees).`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[restore] ECHEC, transaction annulee (base inchangee):', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
