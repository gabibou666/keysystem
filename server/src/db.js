const { Pool } = require('pg');
const { sslOptions, urlSansSslmode, autoritePresente } = require('./db-ssl');

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL manquant. Copie .env.example en .env et remplis-le.');
  process.exit(1);
}

// L'URL est privee de son `sslmode` avant d'etre passee au pool: sinon la valeur
// de l'URL ecrase l'option `ssl` ci-dessous (et `sslmode=require` equivaut
// aujourd'hui a `verify-full`, ce qui casse la connexion chez un hebergeur dont
// l'autorite n'est pas dans le magasin de certificats de Node).
const pool = new Pool({
  connectionString: urlSansSslmode(process.env.DATABASE_URL),
  ssl: sslOptions(process.env.DATABASE_URL),
  max: 10,
  idleTimeoutMillis: 30000,
});

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL.includes('localhost') && !autoritePresente(process.env.DATABASE_URL)) {
  console.log('[db] TLS: chiffrement actif sans verification du certificat (aucune autorite connue pour cet hote)');
}

module.exports = pool;
