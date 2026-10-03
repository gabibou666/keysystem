'use strict';
const fs=require('fs'),path=require('path');
const {files}=require('../src/services/developer-schema');
const db=path.resolve(__dirname,'../db');
const expected=['developer_accounts','developer_identities','developer_sessions','developer_email_tokens','developer_registration_limits','developer_projects','developer_scripts','developer_licenses','developer_events','developer_checkpoints','developer_checkpoint_receipts','developer_hubs','developer_listings','developer_moderation_roles','developer_moderation_submissions','developer_moderation_reports','developer_moderation_audit','developer_checkpoint_proof_uses'];
const created=new Set();
for(const file of files){
  const sql=fs.readFileSync(path.join(db,file),'utf8');
  for(const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi))created.add(match[1]);
  if(/\bDROP\s+TABLE\b|\bTRUNCATE\b/i.test(sql))throw Error('Destructive schema migration '+file);
}
for(const table of expected)if(!created.has(table))throw Error('Missing table '+table);
const unmanaged=fs.readdirSync(db).filter(n=>n.endsWith('.sql')&&!files.includes(n));
if(unmanaged.length)throw Error('Unmanaged SQL files: '+unmanaged.join(', '));
const migration=fs.readFileSync(path.join(__dirname,'../src/migrate.js'),'utf8');
if(!migration.includes('ensureDeveloperSchema'))throw Error('CLI and startup migration paths differ');
console.log('check-schema: '+expected.length+' developer tables, '+files.length+' shared migrations; no legacy or destructive schema.');
