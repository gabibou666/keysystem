#!/usr/bin/env node
/* Affiche la base de donnees qui serait utilisee par migrate/restore, sans
   jamais montrer le secret (hote, port et nom de base uniquement).
   Utile avant une migration: on confirme la cible avant la moindre ecriture.
   Usage: npm run db:target */
'use strict';
const { resoudreUrl } = require('./lib-db-url');

try {
  const r = resoudreUrl({ cibleMigration: true });
  console.log(`source : ${r.source}`);
  console.log(`cible  : ${r.cible}`);
  console.log(
    r.migration
      ? 'etat   : MIGRATION — server/.env.migration est pris en compte'
      : 'etat   : base habituelle (.env) — aucun .env.migration'
  );
} catch (e) {
  console.error('ERREUR:', e.message);
  process.exit(1);
}
