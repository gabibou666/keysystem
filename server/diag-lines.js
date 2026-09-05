// Analyse le build servi: tailles des lignes, ligne 2147
require('dotenv').config();
const pool = require('./src/db');

pool
  .query("SELECT content FROM script_builds WHERE id = 17")
  .then(({ rows }) => {
    const c = rows[0].content;
    const lines = c.split('\n');
    console.log('total: ' + c.length + ' chars, ' + lines.length + ' lignes');

    // top 5 des lignes les plus longues
    const withIdx = lines.map((l, i) => ({ i: i + 1, len: l.length }));
    withIdx.sort((a, b) => b.len - a.len);
    console.log('\n=== TOP 5 LIGNES LES PLUS LONGUES ===');
    withIdx.slice(0, 5).forEach((l) => {
      console.log(`ligne ${l.i}: ${l.len} chars -> ${JSON.stringify(lines[l.i - 1].slice(0, 90))}...`);
    });

    // la ligne 2147 exactement
    console.log('\n=== LIGNE 2147 (erreur executor) ===');
    if (lines[2146]) {
      console.log('longueur: ' + lines[2146].length);
      console.log('debut: ' + JSON.stringify(lines[2146].slice(0, 120)));
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('ERR: ' + e.message);
    process.exit(1);
  });
