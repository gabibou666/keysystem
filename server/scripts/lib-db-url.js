// Resolution de l'URL de base de donnees, avec support de la migration.
//
// POURQUOI CE FICHIER
//   Migrer vers un autre hebergeur demande d'ecrire dans une NOUVELLE base tout
//   en gardant l'ancienne intacte. Mettre le secret dans un fichier plutot que
//   dans un chat permet a l'outillage de l'utiliser sans jamais l'afficher, et
//   d'annoncer la cible (hote/port/base, sans identifiants) avant toute
//   ecriture: ecrire dans la mauvaise base est la seule erreur non rattrapable
//   de cette operation.
//
// Ordre de priorite:
//   server/.env.migration  (si present) -> cible d'une migration en cours
//   server/.env            -> base habituelle
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const FICHIER_MIGRATION = path.join(__dirname, '..', '.env.migration');

// Identifie la base SANS jamais exposer ni utilisateur ni mot de passe.
function masquer(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(URL illisible)';
  }
}

function resoudreUrl({ cibleMigration = false } = {}) {
  if (cibleMigration && fs.existsSync(FICHIER_MIGRATION)) {
    const env = require('dotenv').parse(fs.readFileSync(FICHIER_MIGRATION));
    if (!env.DATABASE_URL) throw new Error('.env.migration present mais sans DATABASE_URL');
    return { url: env.DATABASE_URL, source: '.env.migration', cible: masquer(env.DATABASE_URL), migration: true };
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      cibleMigration
        ? 'Aucune base: ni server/.env.migration ni DATABASE_URL dans .env.'
        : 'DATABASE_URL absent de .env.'
    );
  }
  return { url, source: '.env', cible: masquer(url), migration: false };
}

module.exports = { resoudreUrl, masquer, FICHIER_MIGRATION };
