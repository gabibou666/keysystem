'use strict';
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
async function run() {
  const f=await startFixture();let count=0;
  const check=(condition,label)=>{assert.ok(condition,label);count++;console.log('OK '+label);};
  async function req(path,method='GET',body,cookie=f.cookies[0]) {
    const response=await fetch(f.base+'/api/platform'+path,{method,redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():null,headers:response.headers};
  }
  const browserCookies=headers=>headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  try {
    const project=(await req('/projects','POST',{name:'Four providers'})).data.project.id;
    const oldLoot=(await req('/projects/'+project+'/checkpoints','PUT',{apiToken:'old-lootlabs-token',count:1})).data.postbackUrl;
    check((await req('/projects/'+project+'/checkpoints','PUT',{provider:'workink',linkUrl:'https://evil.example/a',linkId:'10345'})).status===400,'Foreign provider URL rejected');
    check((await req('/projects/'+project+'/checkpoints','PUT',{provider:'workink',linkUrl:'https://work.ink/abc',linkId:'bad'})).status===400,'Non-numeric Work.ink link ID rejected');
    const work=await req('/projects/'+project+'/checkpoints','PUT',{provider:'workink',linkUrl:'https://work.ink/abc',linkId:'10345'});
    check(work.status===200&&!work.data.postbackUrl,'Work.ink can be configured without a secret');
    check(work.data.setup.url.endsWith('/return?token={TOKEN}') && work.data.setup.automatic===true,'Work.ink exposes its usable callback destination and automatic session handling');
    check((await req('/projects/'+project)).data.project.checkpointSetup.url===work.data.setup.url,'Work.ink callback remains available in owner project details');
    check((await fetch(oldLoot+'&click_id='+'a'.repeat(64)+'&unique_id=old')).status===403,'Changing provider revokes old LootLabs postback');
    let start=await req('/checkpoints/'+project+'/start','POST',{},'');
    check(start.status===200&&new URL(start.data.url).searchParams.has('sr'),'Work.ink starts with per-visitor destination override');
    let cookie=browserCookies(start.headers),session=start.data.session;
    const destination=f.providerCalls.findLast(c=>c.provider==='workink-override').destination.replace('{TOKEN}','validtoken123');
    const foreign=await req('/checkpoints/'+project+'/return?session='+session+'&token=validtoken123','GET',undefined,'');
    check(foreign.status===403,'Work.ink return requires original browser');
    check(destination.includes('session='+session),'Generated Work.ink override contains the specific visitor session');
    const returned=await fetch(work.data.setup.url.replace('{TOKEN}','validtoken123'),{redirect:'manual',headers:{Cookie:cookie}});
    check(returned.status===303&&returned.headers.get('location').endsWith('session='+session),'Work.ink verified return redirects to clean claim page');
    check((await req('/checkpoints/'+session+'/status','GET',undefined,cookie)).data.status==='completed','Work.ink completion issues a key');
    const linkvertise=await req('/projects/'+project+'/checkpoints','PUT',{provider:'linkvertise',linkUrl:'https://linkvertise.com/123/456',apiToken:'b'.repeat(64)});
    check(linkvertise.status===200&&linkvertise.data.targetUrl.endsWith('/return'),'Linkvertise exposes the Target Link destination');
    check(linkvertise.data.setup.url===linkvertise.data.targetUrl && linkvertise.data.setup.automatic===false,'Linkvertise exposes the fixed callback to paste in its Target Link');
    start=await req('/checkpoints/'+project+'/start','POST',{},'');cookie=browserCookies(start.headers);session=start.data.session;
    check(start.data.url==='https://linkvertise.com/123/456','Linkvertise starts at creator link');
    const wrong=await req('/checkpoints/'+project+'/return?hash='+'c'.repeat(64),'GET',undefined,cookie);
    check(wrong.status===303&&wrong.headers.get('location').includes('checkpoint=failed'),'Invalid Linkvertise proof rejected');
    const valid=await req('/checkpoints/'+project+'/return?hash='+'a'.repeat(64),'GET',undefined,cookie);
    check(valid.status===303&&!valid.headers.get('location').includes('checkpoint=failed'),'Valid Linkvertise proof accepted');
    check((await req('/checkpoints/'+session+'/status','GET',undefined,cookie)).data.status==='completed','Linkvertise completion issues a key');
    const unlocker=await req('/projects/'+project+'/checkpoints','PUT',{provider:'linkunlocker',linkUrl:'https://linkunlocker.com/u/example',apiToken:'d'.repeat(64)});
    check(unlocker.status===200,'LinkUnlocker can be configured');
    check(unlocker.data.setup.url.endsWith('/return') && unlocker.data.setup.kind==='dynamic-redirect' && unlocker.data.setup.automatic===true,'LinkUnlocker shows its return endpoint with explicit dynamic destination instructions');
    check((await req('/projects/'+project)).data.project.checkpointSetup.url===unlocker.data.setup.url,'LinkUnlocker return endpoint survives project reload');
    start=await req('/checkpoints/'+project+'/start','POST',{},'');cookie=browserCookies(start.headers);session=start.data.session;
    const bare=await fetch(unlocker.data.setup.url,{redirect:'manual',headers:{Cookie:cookie}});
    check(bare.status===303 && bare.headers.get('location').includes('checkpoint=failed'),'Reference endpoint without private proof cannot complete LinkUnlocker');
    check(new URL(start.data.url).searchParams.has('hash'),'LinkUnlocker receives encrypted destination hash');
    const forged=await req('/checkpoints/'+project+'/return?session='+session+'&hash=encrypted_destination_1234567890','GET',undefined,cookie);
    check(forged.status===303&&forged.headers.get('location').includes('checkpoint=failed'),'Public encrypted hash alone cannot complete checkpoint');
    const wrongProof=await req('/checkpoints/'+project+'/return?session='+session+'&proof='+'e'.repeat(64),'GET',undefined,cookie);
    check(wrongProof.status===303&&wrongProof.headers.get('location').includes('checkpoint=failed'),'Forged LinkUnlocker return proof rejected');
    const decrypted=f.providerCalls.findLast(c=>c.provider==='linkunlocker-encrypt').destination;
    const proof=await fetch(decrypted,{redirect:'manual',headers:{Cookie:cookie}});
    check(proof.status===303&&!proof.headers.get('location').includes('checkpoint=failed'),'Decrypted return proof accepted');
    check((await req('/checkpoints/'+session+'/status','GET',undefined,cookie)).data.status==='completed','LinkUnlocker completion issues a key');
    const db=await f.pool.query('SELECT checkpoint_token_enc,checkpoint_token_iv FROM developer_projects WHERE id=$1',[project]);
    check(db.rows[0].checkpoint_token_enc!=='d'.repeat(64)&&!!db.rows[0].checkpoint_token_iv,'Provider API token encrypted at rest');
    console.log(`Checkpoint providers: ${count} checks passed.`);
  } finally {await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
