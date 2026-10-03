'use strict';
const fs = require('fs');
const path = require('path');

// Developer migrations run here, including email normalization. Existing email
// collisions abort the transaction for operator review. Historical tables
// remain managed by the operator's existing migration command.
const files = [
  'migration-developer-platform.sql',
  'migration-developer-signup.sql',
  'migration-developer-zaccount-guards.sql',
  'migration-developer-zcheckpoint-providers.sql',
  'migration-developer-zhubs.sql',
  'migration-developer-zscript-builds.sql',
  'migration-developer-zui.sql',
  'migration-developer-zprofiles.sql',
  'migration-developer-zmoderation.sql',
  'migration-developer-zprovider-guards.sql',
];

async function ensureDeveloperSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('keysystem:developer-platform'))");
    for (const file of files) {
      await client.query(fs.readFileSync(path.join(__dirname, '../../db', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { ensureDeveloperSchema, files };
