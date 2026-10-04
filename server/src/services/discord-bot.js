'use strict';
// Operator-configured server-to-server bridge. Never accepts a browser-supplied URL.
function configuration(){
  const secret=String(process.env.BOT_API_SECRET||'').trim(),raw=String(process.env.BOT_API_URL||'').trim();
  if(!raw||secret.length<32||/[\x00-\x20\x7f]/.test(secret)||secret==='ks_discord_bot_secret_2026')return null;
  try{
    const url=new URL(raw),local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&local&&url.protocol==='http:')))return null;
    return {origin:url.origin,secret};
  }catch{return null;}
}
async function call(path,method='GET',body){
  const config=configuration();if(!config)throw Object.assign(Error('Bot connection is not configured.'),{status:503});
  let response;
  try{response=await fetch(config.origin+path,{method,headers:{Authorization:'Bearer '+config.secret,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(8000)});}catch{throw Object.assign(Error('Bot is unreachable. Check its hosting and connection settings.'),{status:502});}
  if(!response.ok){await response.body?.cancel();throw Object.assign(Error(response.status===401?'Bot authentication failed. Check the shared secret.':response.status===404?'Discord server is unavailable to this bot.':response.status===403?'Bot lacks Discord permissions.':'Bot refused the request.'),{status:response.status===404?404:502});}
  // Bound response size; never pass upstream errors, tokens or arbitrary DTO fields to the browser.
  const reader=response.body?.getReader();if(!reader)throw Object.assign(Error('Invalid bot response.'),{status:502});
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw Error('size');}chunks.push(Buffer.from(value));}const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error('shape');return data;}catch{throw Object.assign(Error('Invalid bot response.'),{status:502});}
}
const id=value=>typeof value==='string'&&/^\d{17,20}$/.test(value);
const text=(value,max=100)=>typeof value==='string'?value.slice(0,max):'';
function statusView(data){
  if(data.success!==true||typeof data.online!=='boolean'||!Array.isArray(data.guilds))throw Object.assign(Error('Invalid bot response.'),{status:502});
  return {configured:true,online:data.online,name:text(data.bot_name),latency:Number.isFinite(data.ws_latency_ms)?data.ws_latency_ms:null,uptime:Number.isFinite(data.uptime_seconds)?Math.max(0,data.uptime_seconds):0,guilds:data.guilds.slice(0,500).filter(g=>id(g.id)).map(g=>({id:g.id,name:text(g.name),memberCount:Number.isSafeInteger(g.member_count)?g.member_count:null,channels:(Array.isArray(g.channels)?g.channels:[]).slice(0,500).filter(c=>id(c.id)).map(c=>({id:c.id,name:text(c.name)})),categories:(Array.isArray(g.categories)?g.categories:[]).slice(0,100).filter(c=>id(c.id)).map(c=>({id:c.id,name:text(c.name)})),roles:(Array.isArray(g.roles)?g.roles:[]).slice(0,250).filter(r=>id(r.id)).map(r=>({id:r.id,name:text(r.name)}))}))};
}
const fields={verification_channel_id:'id',verified_role_id:'id',unverified_role_id:'id',verification_type:'type',ticket_category_id:'id',ticket_channel_id:'id',ticket_log_channel_id:'id',support_role_id:'id',mod_log_channel_id:'id',welcome_channel_id:'id',welcome_message:'text',automod_enabled:'bool',ai_automod_enabled:'bool',anti_invite_enabled:'bool',anti_spam_enabled:'bool'};
function settings(body){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length===0||Object.keys(body).some(k=>!fields[k]))throw Object.assign(Error('Invalid bot settings.'),{status:400});
  const output={};for(const [key,value] of Object.entries(body)){
    const kind=fields[key];
    if(kind==='id'&&(value===null||value===''||id(value)))output[key]=value||null;
    else if(kind==='bool'&&typeof value==='boolean')output[key]=value;
    else if(kind==='type'&&['code','button'].includes(value))output[key]=value;
    else if(kind==='text'&&typeof value==='string'&&value.length<=2000&&!value.includes('\u0000'))output[key]=value;
    else throw Object.assign(Error('Invalid bot setting: '+key),{status:400});
  }return output;
}
function settingsView(data){
  if(data.success!==true||!data.settings||typeof data.settings!=='object')throw Object.assign(Error('Invalid bot response.'),{status:502});
  const result={};for(const [key,kind] of Object.entries(fields)){const value=data.settings[key];if(kind==='id')result[key]=id(value)?value:null;else if(kind==='bool')result[key]=value===1||value===true;else if(kind==='type')result[key]=['code','button'].includes(value)?value:'code';else result[key]=text(value,2000);}return result;
}
module.exports={configuration,call,statusView,settings,settingsView,id};
