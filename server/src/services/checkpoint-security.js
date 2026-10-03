'use strict';
const {isIP}=require('net'),crypto=require('crypto');
function normalizedIp(value){
  if(typeof value!=='string'||!isIP(value))return null;
  if(isIP(value)===4)return value;
  const canonical=new URL('http://['+value+']/').hostname.slice(1,-1).toLowerCase();
  const mapped=canonical.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if(mapped){const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);return [high>>8,high&255,low>>8,low&255].join('.');}
  return canonical;
}
function ipHash(ip){
  const value=normalizedIp(ip);if(!value)return null;
  return crypto.createHmac('sha256',process.env.HMAC_SECRET).update('checkpoint-ip:v1:'+value).digest('hex');
}
function ipMatches(session,ip){
  const actual=ipHash(ip);
  return typeof session.ip_hash==='string'&&/^[a-f0-9]{64}$/.test(session.ip_hash)&&!!actual&&crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(session.ip_hash,'hex'));
}
function proofHash(provider,proof){return crypto.createHash('sha256').update(provider+':'+proof).digest('hex');}
function returnProof(provider,query){
  const proof=provider==='workink'?query.token:provider==='linkvertise'?query.hash:provider==='linkunlocker'?query.proof:null;
  if(typeof proof!=='string')return null;
  if(provider==='workink')return /^[A-Za-z0-9_-]{8,200}$/.test(proof)?proof:null;
  return /^[a-fA-F0-9]{64}$/.test(proof)?proof.toLowerCase():null;
}
module.exports={normalizedIp,ipHash,ipMatches,proofHash,returnProof};
