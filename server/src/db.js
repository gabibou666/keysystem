const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[db] DATABASE_URL manquant. Copie .env.example en .env et remplis-le.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

module.exports = pool;
