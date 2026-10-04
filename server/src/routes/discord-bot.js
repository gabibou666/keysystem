'use strict';
const express=require('express'),rateLimit=require('express-rate-limit');
const auth=require('../services/developer-auth'),moderation=require('../services/moderation'),bridge=require('../services/discord-bot');
const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>res.status(e.status||500).json({success:false,error:e.status?e.message:'Bot operation failed.'}));
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.use(rateLimit({windowMs:60000,max:30,standardHeaders:true,legacyHeaders:false}));
router.use(wrap(async(req,res,next)=>{
  req.account=await auth.account(req);if(!req.account)return res.status(401).json({success:false,error:'Sign in first.'});
  if(await moderation.role(req.account.discord_id)!=='admin')return res.status(403).json({success:false,error:'Platform administrator access required.'});next();
}));
router.get('/status',wrap(async(req,res)=>{
  if(!bridge.configuration())return res.json({success:true,configured:false,online:false,guilds:[]});
  res.json({success:true,...bridge.statusView(await bridge.call('/api/status'))});
}));
router.get('/guilds/:id/settings',wrap(async(req,res)=>{
  if(!bridge.id(req.params.id))return res.status(400).json({success:false,error:'Invalid Discord server ID.'});
  res.json({success:true,settings:bridge.settingsView(await bridge.call('/api/guilds/'+req.params.id+'/settings'))});
}));
router.put('/guilds/:id/settings',wrap(async(req,res)=>{
  const expected=new URL(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).origin;
  if(req.get('origin')!==expected||req.get('sec-fetch-site')==='cross-site')return res.status(403).json({success:false,error:'Invalid origin.'});
  if(!req.is('application/json'))return res.status(415).json({success:false,error:'JSON required.'});
  if(!bridge.id(req.params.id))return res.status(400).json({success:false,error:'Invalid Discord server ID.'});
  const changes=bridge.settings(req.body);
  const result=await bridge.call('/api/guilds/'+req.params.id+'/settings','POST',changes);
  if(result.success!==true)throw Object.assign(Error('Bot did not confirm the update.'),{status:502});
  // Discord and PostgreSQL cannot share a transaction. Log outcome without storing messages or secrets.
  try{await moderation.audit(require('../db'),{action:'bot.settings_updated',actorId:req.account.discord_id,subjectId:req.params.id,statusCode:200});}catch{console.error('[audit] bot settings event persistence failed');}
  res.json({success:true});
}));
module.exports=router;
