'use strict';
const crypto=require('crypto');
const COOKIE='ah_registration';
const WINDOW=86400000;
const digest=value=>crypto.createHmac('sha256',process.env.HMAC_SECRET).update('registration:v1:'+value).digest('hex');
function context(req,res) {
  const cookie=req.cookies?.[COOKIE];
  let id;
  if(typeof cookie==='string' && /^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(cookie)) {
    const [candidate,signature]=cookie.split('.');
    if(crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(digest('cookie:'+candidate),'hex'))) id=candidate;
  }
  if(!id) {
    id=crypto.randomBytes(32).toString('hex');
    res.cookie(COOKIE,id+'.'+digest('cookie:'+id),{httpOnly:true,secure:process.env.NODE_ENV==='production'||(process.env.PUBLIC_URL||'').startsWith('https:'),sameSite:'lax',path:'/',maxAge:WINDOW*180});
  }
  return {network:digest('network:'+req.ip),browser:digest('browser:'+id)};
}
function limitError() {const e=new Error('Account creation limit reached. Sign in to your existing account or try again tomorrow.');e.code='ACCOUNT_CREATION_LIMIT';return e;}
async function reserve(client,keys) {
  if(!keys) return; // Internal callers without HTTP context do not apply network policy.
  const limits=[{key:'browser:'+keys.browser,max:1},{key:'network:'+keys.network,max:5}].sort((a,b)=>a.key.localeCompare(b.key));
  for(const {key,max} of limits) {
    await client.query('INSERT INTO developer_registration_limits(quota_key,window_start,account_count) VALUES($1,$2,0) ON CONFLICT(quota_key) DO NOTHING',[key,new Date()]);
    const {rows}=await client.query('SELECT window_start,account_count FROM developer_registration_limits WHERE quota_key=$1 FOR UPDATE',[key]);
    const fresh=Date.now()-new Date(rows[0].window_start).getTime()<WINDOW;
    const count=fresh?rows[0].account_count:0;
    if(count>=max) throw limitError();
    await client.query('UPDATE developer_registration_limits SET window_start=$1,account_count=$2 WHERE quota_key=$3',[fresh?rows[0].window_start:new Date(),count+1,key]);
  }
}
module.exports={context,reserve,COOKIE};
