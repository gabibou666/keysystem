'use strict';
const {createHmac}=require('crypto');
const {normalizedIp}=require('./checkpoint-security');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function hash(value){return createHmac('sha256',process.env.HMAC_SECRET).update('script-metrics:v1:'+value).digest('hex');}
function visitorReceipt(req,projectId,kind='views'){
  const ip=normalizedIp(req.ip);if(!ip)return null;
  // Daily, project-specific pseudonym; no IP, user agent or persistent browser ID is stored.
  return hash(JSON.stringify([kind,projectId.toLowerCase(),new Date().toISOString().slice(0,10),ip]));
}
function executionReceipt(licenseId,executionId){return hash(JSON.stringify(['executions',licenseId,executionId.toLowerCase()]));}
async function record(db,projectId,kind,receipt){
  if(!['views','executions'].includes(kind)||!receipt)return false;
  const lock=Buffer.from(receipt,'hex');
  await db.query('SELECT pg_advisory_xact_lock($1,$2)',[lock.readInt32BE(0),lock.readInt32BE(4)]);
  if((await db.query('SELECT project_id FROM developer_script_metric_receipts WHERE project_id=$1 AND kind=$2 AND receipt_hash=$3',[projectId,kind,receipt])).rows.length)return false;
  // Caller owns the transaction: receipts and counters must commit together.
  const result=await db.query(`INSERT INTO developer_script_metric_receipts(project_id,kind,receipt_hash,expires_at)
    VALUES($1,$2,$3,$4) ON CONFLICT(project_id,kind,receipt_hash) DO NOTHING RETURNING project_id`,
  [projectId,kind,receipt,new Date(Date.now()+48*60*60*1000)]);
  if(!result.rows.length)return false;
  await db.query(`INSERT INTO developer_script_metrics(project_id,${kind}) VALUES($1,1)
    ON CONFLICT(project_id) DO UPDATE SET ${kind}=developer_script_metrics.${kind}+1`,[projectId]);
  return true;
}
function view(row={}){return {views:Number(row.views||0),executions:Number(row.executions||0)};}
module.exports={UUID,visitorReceipt,executionReceipt,record,view};
