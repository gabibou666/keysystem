'use strict';
const crypto=require('crypto');
let keysCache;
// Only accept Google's signed ID tokens, from the fixed official JWKS endpoint.
async function verifyIdToken(token,nonce) {
  if(typeof token!=='string'||token.length>20000) throw new Error('Invalid identity token');
  const parts=token.split('.'); if(parts.length!==3) throw new Error('Invalid identity token');
  const header=JSON.parse(Buffer.from(parts[0],'base64url').toString());
  const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
  if(header.alg!=='RS256'||typeof header.kid!=='string') throw new Error('Invalid identity signature');
  if(!keysCache || keysCache.expires<Date.now() || !keysCache.keys.some(k=>k.kid===header.kid)) {
    const result=await fetch('https://www.googleapis.com/oauth2/v3/certs',{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!result.ok) throw new Error('Identity service unavailable');
    const data=await result.json(); keysCache={keys:data.keys,expires:Date.now()+3600000};
  }
  const jwk=keysCache.keys.find(k=>k.kid===header.kid && k.kty==='RSA' && k.use==='sig' && k.alg==='RS256');
  if(!jwk || !crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),crypto.createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url'))) throw new Error('Invalid identity signature');
  const now=Math.floor(Date.now()/1000);
  if(!['https://accounts.google.com','accounts.google.com'].includes(claims.iss)||claims.aud!==process.env.GOOGLE_CLIENT_ID||(claims.azp && claims.azp!==process.env.GOOGLE_CLIENT_ID)||typeof claims.exp!=='number'||claims.exp<=now||typeof claims.iat!=='number'||claims.iat>now+60||claims.nonce!==nonce||typeof claims.sub!=='string'||!claims.sub) throw new Error('Invalid identity claims');
  return claims;
}
module.exports={verifyIdToken};
