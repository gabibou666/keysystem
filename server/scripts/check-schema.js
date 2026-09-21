#!/usr/bin/env node
/* ============================================================================
   check-schema.js — garde-fou de la RECREATION DE BASE.

   POURQUOI CE CONTROLE EXISTE
   src/migrate.js n'appliquait que db/schema.sql, qui ne cree que 11 des 21
   tables du projet: les 10 autres vivent dans db/migration-*.sql. Une base
   recreee (nouvel hebergeur, restauration d'une sauvegarde) etait donc
   silencieusement incomplete — la restauration echouait en cours de route, ou
   l'application demarrait avec des tables manquantes. Ce controle empeche que
   la chaine de migration perde de nouveau une table.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const dbDir = path.join(RACINE, 'db');
const migrateSrc = fs.readFileSync(path.join(RACINE, 'src', 'migrate.js'), 'utf8');

// Tables sans lesquelles l'application ne fonctionne pas. Si l'une disparait des
// fichiers SQL, c'est une regression, pas un choix.
const CRITIQUES = [
  'keys',
  'll_sessions',
  'executions',
  'script_versions',
  'script_builds',
  'admin_sessions',
  'beacons',
  'user_cache',
];

const fichiers = fs.readdirSync(dbDir).filter((f) => f.endsWith('.sql'));
const tables = new Map(); // table -> fichier qui la cree
for (const f of fichiers) {
  const sql = fs.readFileSync(path.join(dbDir, f), 'utf8');
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-z_]+)/gi)) {
    const t = m[1].toLowerCase();
    if (!tables.has(t)) tables.set(t, f);
  }
}

const problems = [];

for (const t of CRITIQUES) {
  if (!tables.has(t)) problems.push(`aucun fichier de db/ ne cree la table ${t}`);
}
if (tables.size < 21) {
  problems.push(`${tables.size} tables declarees au total, 21 attendues (un fichier SQL a-t-il ete supprime ?)`);
}

// migrate.js doit appliquer TOUS les fichiers de schema, pas seulement schema.sql.
if (!/schema\.sql/.test(migrateSrc)) {
  problems.push("src/migrate.js n'applique plus db/schema.sql");
}
const appliqueLesMigrations =
  /migration-/.test(migrateSrc) && /readdirSync\s*\(\s*dbDir\s*\)/.test(migrateSrc);
if (!appliqueLesMigrations) {
  problems.push(
    "src/migrate.js n'applique pas les fichiers db/migration-*.sql: une base recreee serait INCOMPLETE"
  );
}

if (problems.length) {
  console.error(`❌ check-schema: ${problems.length} probleme(s)`);
  problems.forEach((p) => console.error(`   • ${p}`));
  process.exit(1);
}
console.log(
  `✅ check-schema: ${tables.size} tables couvertes par ${fichiers.length} fichiers SQL ` +
    `(${1 + fichiers.filter((f) => /^migration-/.test(f)).length} appliques par migrate.js), et migrate.js les applique tous.`
);
