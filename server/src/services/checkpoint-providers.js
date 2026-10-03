'use strict';
const security=require('./checkpoint-security');
const URL_HOSTS={workink:new Set(['work.ink','www.work.ink']),linkvertise:new Set(['linkvertise.com','www.linkvertise.com']),linkunlocker:new Set(['linkunlocker.com','www.linkunlocker.com'])};
const names={lootlabs:'LootLabs',workink:'Work.ink',linkvertise:'Linkvertise',linkunlocker:'LinkUnlocker'};
function setup(project, site, postbackUrl) {
  const provider = project.checkpoint_provider || 'lootlabs';
  const endpoint = `${site}/api/platform/checkpoints/${project.id}/return`;
  const options = {
    lootlabs: { kind:'postback', url:postbackUrl, automatic:false, label:'LootLabs callback URL (postback)',
      instruction:'Paste this private callback into LootLabs > Advanced > Postback. Enable click_id, unique_id and ip. Keep the secret parameter unchanged. Tasks must come from the network that started the checkpoint.',
      docsUrl:'https://help.lootlabs.gg/en/article/postback-api-1ndz3i2/' },
    workink: { kind:'redirect', url:endpoint+'?token={TOKEN}', automatic:true, label:'Work.ink callback / destination',
      instruction:'This destination can be used when creating your Work.ink link. Keep {TOKEN} unchanged. We override it per visitor with their session and verify the returned token and link ID.',
      docsUrl:'https://blog.work.ink/using-the-key-system-to-make-money-with-your-software/' },
    linkvertise: { kind:'redirect', url:endpoint, automatic:false, label:'Linkvertise callback / Target Link destination',
      instruction:'Paste this as your Target Link destination. Enable anti-bypassing in Linkvertise. Paste-Links are not supported; this feature affects all your Target Links.',
      docsUrl:'https://publisher.linkvertise.com/documentations/Anti_Bypass_Documentation.pdf' },
    linkunlocker: { kind:'dynamic-redirect', url:endpoint, automatic:true, label:'LinkUnlocker return endpoint (automatic)',
      instruction:'This is the return endpoint for reference. No callback needs to be pasted. We encrypt a complete destination with a fresh session and proof for each visitor; this base URL alone cannot complete a checkpoint.',
      docsUrl:'https://linkunlocker.com/docs/anti-bypass' },
  };
  return { provider, ...options[provider] };
}
function safeLink(value,provider) {
  if(typeof value!=='string'||value.length>1000)return null;
  try {const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||!URL_HOSTS[provider]?.has(url.hostname)||url.hash||url.searchParams.has('hash')||url.searchParams.has('sr'))return null;return url.toString();}catch{return null;}
}
async function bodyJson(response) {if(!response.ok)throw Error('Provider request failed');return response.json();}
// Credentials and user proofs are sent only to the documented endpoint. Never
// follow a redirect (including same-host redirects) carrying those secrets.
const providerFetch = (url, options = {}) => fetch(url, { ...options, redirect: 'error' });
async function prepareStart(project,session,site,decrypt,random,hash) {
  const provider=project.checkpoint_provider||'lootlabs';
  if(provider==='lootlabs') {
    const result=await providerFetch('https://creators.lootlabs.gg/api/public/content_locker',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${decrypt(project.lootlabs_token_enc,project.lootlabs_token_iv)}`},body:JSON.stringify({title:project.name,url:`${site}/claim?project=${project.id}&session=${session}`,tier_id:1,number_of_tasks:project.checkpoint_count,theme:1}),signal:AbortSignal.timeout(15000)});
    const data=await bodyJson(result),message=Array.isArray(data.message)?data.message[0]:data.message,link=message?.loot_url;
    if(typeof link!=='string'||link.length>2000)throw Error('Provider did not return a link');
    const url=new URL(link);url.searchParams.set('puid',session);url.searchParams.set('subid',session);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!(url.hostname==='loot-link.com'||url.hostname==='lootlabs.gg'||url.hostname.endsWith('.lootlabs.gg')))throw Error('Provider returned an unexpected host');
    return {url:url.href,provider,reference:null,proofHash:null};
  }
  const link=new URL(project.checkpoint_link_url);
  if(provider==='linkvertise')return {url:link.href,provider,reference:null,proofHash:null};
  if(provider==='workink') {
    const destination=`${site}/api/platform/checkpoints/${project.id}/return?session=${session}&token={TOKEN}`;
    const endpoint=new URL('https://work.ink/_api/v2/override');endpoint.searchParams.set('destination',destination);
    const data=await bodyJson(await providerFetch(endpoint,{signal:AbortSignal.timeout(15000)}));
    if(typeof data.sr!=='string'||!/^[A-Za-z0-9_+/=-]{16,2000}$/.test(data.sr))throw Error('Provider did not return a valid override');
    link.searchParams.set('sr',data.sr);return {url:link.href,provider,reference:null,proofHash:null};
  }
  if(provider==='linkunlocker') {
    const proof=random(32);
    const destination=`${site}/api/platform/checkpoints/${project.id}/return?session=${session}&proof=${proof}`;
    const token=decrypt(project.checkpoint_token_enc,project.checkpoint_token_iv);
    const data=await bodyJson(await providerFetch('https://linkunlocker.com/api/public/url_encryptor',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({destination_url:destination}),signal:AbortSignal.timeout(15000)}));
    const reference=data.hash||data.message;
    if(typeof reference!=='string'||!/^[A-Za-z0-9_-]{16,2000}$/.test(reference))throw Error('Provider did not return an encrypted destination');
    link.searchParams.set('hash',reference);
    return {url:link.href,provider,reference,proofHash:hash(proof)};
  }
  throw Error('Unknown checkpoint provider');
}
async function verifyReturn(project,session,query,decrypt,hash) {
  const provider=session.provider;
  if(provider==='workink') {
    const token=query.token;
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{8,200}$/.test(token))return false;
    const endpoint=`https://work.ink/_api/v2/token/isValid/${encodeURIComponent(token)}?deleteToken=1`;
    const data=await bodyJson(await providerFetch(endpoint,{signal:AbortSignal.timeout(10000)}));
    const info=data.info,now=Date.now(),started=new Date(session.created_at).getTime();
    return data.valid===true&&info?.token===token&&String(info.linkId)===project.checkpoint_link_id&&
      typeof info.createdAt==='number'&&Number.isFinite(info.createdAt)&&info.createdAt>=started&&info.createdAt<=now+30000&&
      typeof info.expiresAfter==='number'&&info.expiresAfter>now&&security.ipMatches(session,info.byIp);
  }
  if(provider==='linkvertise') {
    const value=query.hash;
    if(typeof value!=='string'||!/^[a-fA-F0-9]{64}$/.test(value))return false;
    const endpoint=new URL('https://publisher.linkvertise.com/api/v1/anti_bypassing');
    endpoint.searchParams.set('token',decrypt(project.checkpoint_token_enc,project.checkpoint_token_iv));endpoint.searchParams.set('hash',value);
    const response=await providerFetch(endpoint,{method:'POST',signal:AbortSignal.timeout(10000)});
    if(!response.ok)return false;
    const answer=(await response.text()).trim();return answer==='TRUE'||answer==='true'||answer==='"TRUE"'||answer==='"true"';
  }
  if(provider==='linkunlocker') {
    const proof=query.proof;
    if(typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof)||hash(proof)!==session.return_proof_hash||!session.provider_reference)return false;
    const endpoint=new URL('https://linkunlocker.com/api/public/hash/validate');
    endpoint.searchParams.set('hash',session.provider_reference);
    endpoint.searchParams.set('api_token',decrypt(project.checkpoint_token_enc,project.checkpoint_token_iv));endpoint.searchParams.set('deleteToken','1');
    const data=await bodyJson(await providerFetch(endpoint,{signal:AbortSignal.timeout(10000)}));return data.valid===true;
  }
  return false;
}
module.exports={names,safeLink,prepareStart,verifyReturn,setup};
