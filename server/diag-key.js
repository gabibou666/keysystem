// Affiche la cle complete du dernier utilisateur (la sienne)
require('dotenv').config();
const pool = require('./src/db');

pool
  .query('SELECT kid, signature, expires_at FROM keys ORDER BY created_at DESC LIMIT 1')
  .then(({ rows }) => {
    if (!rows[0]) return console.log('aucune cle');
    const k = rows[0];
    console.log('CLE: ' + k.kid + '.' + k.signature);
    console.log('EXPIRE: ' + new Date(k.expires_at).toLocaleString('fr-FR'));
    process.exit(0);
  })
  .catch((e) => {
    console.error('ERR: ' + e.message);
    process.exit(1);
  });
