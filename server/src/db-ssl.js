// Options TLS pour PostgreSQL — la question qui bloque une migration.
//
// POURQUOI CE FICHIER
//   Les versions recentes de pg / pg-connection-string traitent `sslmode=require`
//   (et `prefer`, `verify-ca`) comme `verify-full` — c'est le avertissement que
//   l'hebergeur affiche au demarrage. Consequence: le certificat presente par le
//   serveur doit etre validé contre une autorite de confiance, sinon la connexion
//   echoue en SELF_SIGNED_CERT_IN_CHAIN. C'est le cas d'Aiven, dont l'autorite est
//   privee et absente du magasin de certificats de Node.
//
// Regle appliquee ici:
//   - si db/aiven-ca.pem existe (autorite recuperee depuis la console Aiven, ou
//     capturee lors d'une premiere connexion par scripts/capture-ca.js):
//     verification COMPLETE du certificat (rejectUnauthorized: true);
//   - sinon: chiffrement actif mais sans verification du certificat — le meme
//     niveau que la configuration existante, et le demarrage le signale.
//
// L'option `ssl` explicite doit etre passee au client SANS laisser l'URL
// l'ecraser: les valeurs parsees de la chaine de connexion priment sur les
// options du constructeur dans pg. Les appels retirent donc `sslmode` de l'URL.
'use strict';
const fs = require('fs');
const path = require('path');

const CHEMIN_CA = path.join(__dirname, '..', 'db', 'aiven-ca.pem');

function estLocale(url) {
  return /(^|@)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url || '');
}

// Retire sslmode de l'URL: l'option `ssl` explicite fait foi, et `sslmode` de
// l'URL la remplacerait en silence.
function urlSansSslmode(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

function sslOptions(url) {
  if (estLocale(url)) return false;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  // L'autorite d'un hebergeur ne doit servir QUE pour cet hebergeur: verifier
  // Neon avec le certificat d'Aiven (ou l'inverse) fait echouer la connexion en
  // "unable to get local issuer certificate", c'est-a-dire une panne totale du
  // site. Le chemin explicite PG_CA_FILE reste prioritaire.
  const candidats = [];
  if (process.env.PG_CA_FILE) candidats.push(process.env.PG_CA_FILE);
  if (/aivencloud\.com$/i.test(host)) candidats.push(CHEMIN_CA);
  for (const fichier of candidats) {
    if (fs.existsSync(fichier)) {
      return { ca: fs.readFileSync(fichier, 'utf8'), rejectUnauthorized: true };
    }
  }
  return { rejectUnauthorized: false };
}

// L'autorite attendue pour CETTE base est-elle disponible ?
function autoritePresente(url) {
  if (process.env.PG_CA_FILE) return fs.existsSync(process.env.PG_CA_FILE);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return /aivencloud\.com$/i.test(host) && fs.existsSync(CHEMIN_CA);
}

module.exports = { sslOptions, urlSansSslmode, autoritePresente, CHEMIN_CA };
