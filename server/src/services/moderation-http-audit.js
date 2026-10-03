'use strict';
// Fixed route names only: no request bodies, URL queries, IPs, cookies or headers.
const pool=require('../db'),moderation=require('./moderation');
const actions={
  platform:{
    'POST /projects':'project.created','PATCH /projects/:projectId':'project.updated',
    'POST /projects/:projectId/token':'project.token_rotated','PUT /projects/:projectId/key-ui':'key_ui.updated',
    'POST /projects/:projectId/licenses':'license.issued','POST /v1/projects/:projectId/licenses':'license.issued',
    'PUT /projects/:projectId/checkpoints':'checkpoint.updated',
    'POST /checkpoints/:projectId/start':'checkpoint.start'
  },
  auth:{'POST /signup':'auth.signup','POST /verify':'auth.verified','POST /login':'auth.login','POST /logout':'auth.logout','POST /reset':'auth.reset'},
};
const pending=new Set();
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function middleware(group){return (req,res,next)=>{
  res.once('finish',()=>{
    let action=actions[group]?.[req.method+' '+req.route?.path];
    if(group==='platform'&&req.method==='POST'&&req.route?.path==='/projects/:projectId/licenses/:licenseId/:action')action={revoke:'license.revoked',restore:'license.restored','reset-device':'license.device_reset'}[req.params.action];
    if(group==='platform'&&req.method==='GET'&&['/checkpoints/:projectId/postback','/checkpoints/:projectId/return'].includes(req.route?.path))action=req.checkpointOutcome||'checkpoint.failed';
    if(!action)return;
    if(pending.size>=1000){console.error('[audit] queue limit reached');return;}
    const operation=moderation.audit(pool,{action,actorId:req.developerId||req.auditActorId||req.account?.discord_id||null,projectId:UUID.test(req.params.projectId||'')?req.params.projectId:null,statusCode:res.statusCode}).catch(()=>{console.error('[audit] event persistence failed');}).finally(()=>pending.delete(operation));
    pending.add(operation);
  });next();
};}
async function flush(){await Promise.allSettled([...pending]);}
module.exports={middleware,flush};
