#!/usr/bin/env node
/* ============================================================================
   capture-ca.js — enregistre l'autorite de certification presentee par la base.

   POURQUOI
   Un hebergeur comme Aiven signe ses certificats avec SA PROPRE autorite, absente
   du magasin de certificats de Node. Or `sslmode=require` equivaut aujourd'hui a
   `verify-full`: la connexion echoue donc en SELF_SIGNED_CERT_IN_CHAIN. En
   enregistrant cette autorite dans db/aiven-ca.pem, la verification du certificat
   devient possible (rejectUnauthorized: true) au lieu d'etre desactivee.

   Ce fichier n'est pas un secret: un certificat d'autorite est public, et il ne
   permet pas de se faire passer pour le serveur -- il permet seulement de le
   verifier.

   ATTENTION: l'autorite est ici recuperee lors de la PREMIERE connexion (confiance
   a l'aveugle). Pour une confiance parfaitement etablie, telechargez le certificat
   dans la console Aiven et remplacez db/aiven-ca.pem par ce fichier.

   Usage: node scripts/capture-ca.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { resoudreUrl } = require('./lib-db-url');

const DESTINATION = path.join(__dirname, '..', 'db', 'aiven-ca.pem');

function versPem(der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

(async () => {
  const cible = resoudreUrl({ cibleMigration: true });
  const u = new URL(cible.url);
  console.log(`[ca] connexion a ${u.hostname}:${u.port || 5432} (${cible.source})`);

  const socket = tls.connect(
    { host: u.hostname, port: Number(u.port || 5432), servername: u.hostname, rejectUnauthorized: false },
    () => {
      try {
        const chaine = [];
        let certificat = socket.getPeerCertificate(true);
        while (certificat && certificat.raw && chaine.length < 8) {
          chaine.push(certificat);
          const suivant = certificat.issuerCertificate;
          if (!suivant || !suivant.raw || suivant.fingerprint === certificat.fingerprint) break;
          certificat = suivant;
        }
        const racine = chaine[chaine.length - 1];
        if (!racine || !racine.raw) throw new Error('chaine de certificats illisible');
        fs.writeFileSync(DESTINATION, versPem(racine.raw));
        console.log(`[ca] ${chaine.length} certificat(s) dans la chaine`);
        console.log(`[ca] autorite enregistree: ${path.relative(process.cwd(), DESTINATION)}`);
        console.log(`[ca] sujet: ${racine.subject?.CN || '(inconnu)'} · valide jusqu'au ${racine.valid_to}`);
      } catch (e) {
        console.error('[ca] ECHEC:', e.message);
        process.exitCode = 1;
      } finally {
        socket.end();
      }
    }
  );
  socket.on('error', (e) => {
    console.error('[ca] ECHEC de connexion:', e.message);
    process.exit(1);
  });
})();
