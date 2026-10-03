'use strict';
require('dotenv').config();
const {Pool}=require('pg');
const {files,ensureDeveloperSchema}=require('./services/developer-schema');
const {resoudreUrl}=require('../scripts/lib-db-url');
const {sslOptions,urlSansSslmode}=require('./db-ssl');
async function main(){
  // Dry run is strictly local and does not need credentials.
  if(process.argv.includes('--dry-run')){for(const file of files)console.log(file);console.log('Dry run: no database connection or write.');return;}
  const target=resoudreUrl({cibleMigration:true});
  console.log('[migrate] '+target.cible+' ('+target.source+')');
  const pool=new Pool({connectionString:urlSansSslmode(target.url),ssl:sslOptions(target.url)});
  try{await ensureDeveloperSchema(pool);console.log('[migrate] Developer schema ready. Existing unrelated tables were not modified.');}
  finally{await pool.end();}
}
main().catch(error=>{console.error('[migrate]',error.code||error.name);process.exitCode=1;});
