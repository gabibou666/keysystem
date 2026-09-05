require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  console.log('[migrate] Application du schema...');
  await pool.query(schema);
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'"
  );
  console.log('[migrate] Tables presentes:', rows.map((r) => r.tablename).join(', '));
  await pool.end();
}

migrate().catch((e) => {
  console.error('[migrate] ERREUR:', e.message);
  process.exit(1);
});
