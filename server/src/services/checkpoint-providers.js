'use strict';
const URL_HOSTS={workink:new Set(['work.ink','www.work.ink']),linkvertise:new Set(['linkvertise.com','www.linkvertise.com']),linkunlocker:new Set(['linkunlocker.com','www.linkunlocker.com'])};
const names={lootlabs:'LootLabs',workink:'Work.ink',linkvertise:'Linkvertise',linkunlocker:'LinkUnlocker'};
function safeLink(value,provider) {
  if(typeof value!=='string'||value.length>1000)return null;
  try {const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||!URL_HOSTS[provider]?.has(url.hostname)||url.hash||url.searchParams.has('hash')||url.searchParams.has('sr'))return null;return url.toString();}catch{return null;}
}
async function bodyJson(response) {if(!response.ok)throw Error('Provider request failed');return response.json();}
async function prepareStart(project,session,site,decrypt,random,hash) {
  const provider=project.checkpoint_provider||'lootlabs';
  if(provider==='lootlabs') {
    const result=await fetch('https://creators.lootlabs.gg/api/public/content_locker',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${decrypt(project.lootlabs_token_enc,project.lootlabs_token_iv)}`},body:JSON.stringify({title:project.name,url:`${site}/claim?project=${project.id}&session=${session}`,tier_id:1,number_of_tasks:project.checkpoint_count,theme:1}),signal:AbortSignal.timeout(15000)});
    const data=await bodyJson(result),message=Array.isArray(data.message)?data.message[0]:data.message,link=message?.loot_url;
    if(!link||!/^https:\/\//.test(link))throw Error('Provider did not return a link');
    const url=new URL(link);url.searchParams.set('puid',session);url.searchParams.set('subid',session);
    return {url:url.href,provider,reference:null,proofHash:null};
  }
  const link=new URL(project.checkpoint_link_url);
  if(provider==='linkvertise')return {url:link.href,provider,reference:null,proofHash:null};
  if(provider==='workink') {
    const destination=`${site}/api/platform/checkpoints/${project.id}/return?session=${session}&token={TOKEN}`;
    const endpoint=new URL('https://work.ink/_api/v2/override');endpoint.searchParams.set('destination',destination);
    const data=await bodyJson(await fetch(endpoint,{signal:AbortSignal.timeout(15000)}));
    if(typeof data.sr!=='string'||!/^[A-Za-z0-9_+/=-]{16,2000}$/.test(data.sr))throw Error('Provider did not return a valid override');
    link.searchParams.set('sr',data.sr);return {url:link.href,provider,reference:null,proofHash:null};
  }
  if(provider==='linkunlocker') {
    const proof=random(32);
    const destination=`${site}/api/platform/checkpoints/${project.id}/return?session=${session}&proof=${proof}`;
    const token=decrypt(project.checkpoint_token_enc,project.checkpoint_token_iv);
    const data=await bodyJson(await fetch('https://linkunlocker.com/api/public/url_encryptor',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({destination_url:destination}),signal:AbortSignal.timeout(15000)}));
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
    const data=await bodyJson(await fetch(endpoint,{signal:AbortSignal.timeout(10000)}));
    return data.valid===true&&String(data.info?.linkId)===project.checkpoint_link_id&&Number(data.info?.expiresAfter)>Date.now();
  }
  if(provider==='linkvertise') {
    const value=query.hash;
    if(typeof value!=='string'||!/^[a-fA-F0-9]{64}$/.test(value))return false;
    const endpoint=new URL('https://publisher.linkvertise.com/api/v1/anti_bypassing');
    endpoint.searchParams.set('token',decrypt(project.checkpoint_token_enc,project.checkpoint_token_iv));endpoint.searchParams.set('hash',value);
    const response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(10000)});
    if(!response.ok)return false;
    const answer=(await response.text()).trim();return answer==='TRUE'||answer==='true'||answer==='"TRUE"'||answer==='"true"';
  }
  if(provider==='linkunlocker') {
    const proof=query.proof;
    if(typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof)||hash(proof)!==session.return_proof_hash||!session.provider_reference)return false;
    const endpoint=new URL('https://linkunlocker.com/api/public/hash/validate');
    endpoint.searchParams.set('hash',session.provider_reference);
    endpoint.searchParams.set('api_token',decrypt(project.checkpoint_token_enc,project.checkpoint_token_iv));endpoint.searchParams.set('deleteToken','1');
    const data=await bodyJson(await fetch(endpoint,{signal:AbortSignal.timeout(10000)}));return data.valid===true;
  }
  return false;
}
module.exports={names,safeLink,prepareStart,verifyReturn};
