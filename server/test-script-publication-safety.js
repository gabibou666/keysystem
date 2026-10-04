'use strict';
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
const {waitJob}=require('./tests/script-jobs');
async function run(){
 const f=await startFixture(),builder=require('./src/services/script-builder'),crypto=require('./src/services/crypto');
 const nativeBuild=builder.build;let checks=0,transforms=0;
 const check=(value,label)=>{assert.ok(value,label);checks++;console.log('OK '+label);};
 async function request(route,body){const r=await fetch(f.base+route,{method:'PUT',headers:{Cookie:f.cookies[0],Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 async function submit(content,obfuscate=false){const r=await request('/api/platform/projects/'+id+'/script',{content,obfuscate,...(obfuscate?{obfuscationLevel:'standard'}:{})});assert.equal(r.status,202,JSON.stringify(r.data));return waitJob(f,id,r.data.jobId,f.cookies[0]);}
 let id;
 try{
  const created=await fetch(f.base+'/api/platform/projects',{method:'POST',headers:{Cookie:f.cookies[0],Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({name:'Safety pipeline'})});id=(await created.json()).project.id;
  const baseline=await submit('return 1');check(baseline.status==='succeeded','Readable source passes real compiler and both automatic scans');
  await f.pool.query("UPDATE developer_scripts SET safety_status='quarantined' WHERE project_id=$1",[id]);
  const unchangedQuarantine=await submit('return 1');
  check(unchangedQuarantine.status==='failed'&&unchangedQuarantine.error.code==='SECURITY_UNVERIFIED','An identical quarantined build cannot be restored by reuploading it');
  const replacement=await submit('return 2');
  check(replacement.status==='succeeded'&&replacement.result.securityStatus==='clear','A different readable replacement passes fresh automatic verification without human approval');
  check(await require('./src/services/moderation').deliveryAllowed(id,replacement.result.version,crypto.sha256('return 2')),'Activation persists a matching current automatic proof atomically');
  const previous=(await f.pool.query('SELECT version,build_hash FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
  const cache=await submit('local read=readfile; assert(read("license-cache.json")); local ui=game:HttpGet("https://example.invalid/ui.lua"); return ui');
  check(cache.status==='failed'&&cache.error.code==='SECURITY_UNVERIFIED','Local key cache and HTTP are refused when automatic verification is inconclusive');
  check(cache.result.findings.some(f=>f.rule==='sensitive_network_transfer'&&f.severity==='review'),'Owner receives the precise heuristic finding without source contents');
  check((await f.pool.query('SELECT version FROM developer_scripts WHERE project_id=$1',[id])).rows[0].version===previous.version,'An inconclusive cache cannot replace the active version');
  const template=await nativeBuild('return 2');
  function output(code){builder.build=async()=>{transforms++;return {...template,code,obfuscated:true,obfuscate:true,obfuscationLevel:'standard',buildHash:crypto.sha256(code),outputSizeBytes:Buffer.byteLength(code)};};}
  const opaque='local bytes={'+Array(1100).fill(42).join(',')+'};while true do local op=bytes[1] end';
  output(opaque);const generated=await submit('return 2',true);
  check(generated.status==='failed'&&generated.error.code==='SECURITY_UNVERIFIED','Obfuscation flag cannot exempt an opaque generated VM from automatic refusal');
  const pending=(await f.pool.query("SELECT findings FROM developer_moderation_submissions WHERE project_id=$1 AND status='pending'",[id])).rows;
  check(pending.length===0&&JSON.stringify(generated.result.findings).includes('opaque_virtualized_payload'),'Refused output preserves actionable findings without creating a human review submission');
  const kept=(await f.pool.query('SELECT version,build_hash FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
  check(kept.version===previous.version&&kept.build_hash===previous.build_hash,'Review does not replace the previous active release');
  output('os.execute("SHOULD_NEVER_EXECUTE")');const malicious=await submit('return 3',true);
  check(malicious.status==='failed'&&malicious.error.code==='SECURITY_BLOCKED','Malicious transformed output is blocked');
  output('return 4');const remote=await submit('loadstring(game:HttpGet("https://example.invalid/not-fetched.lua"))()',true);
  check(remote.status==='failed'&&remote.error.code==='SECURITY_UNVERIFIED','A clean output cannot erase remote-loader findings on the original');
  const calls=transforms;const sourceAttack=await submit('os.execute("SHOULD_NEVER_EXECUTE")');
  check(sourceAttack.status==='failed'&&sourceAttack.error.code==='SECURITY_BLOCKED'&&transforms===calls,'Malicious original is refused before invoking the builder');
  const beforeOpaque=transforms;
  output(opaque);const raw=await submit(opaque);
  check(raw.status==='failed'&&raw.error.code==='SECURITY_UNVERIFIED','Already obfuscated uploads cannot pass automatic verification');
  check(transforms===beforeOpaque,'Inconclusive source is refused before invoking an obfuscator');
  output(';'.repeat(150001));const limited=await submit('return 5',true);
  check(limited.status==='failed'&&limited.error.code==='SECURITY_UNVERIFIED','Output scanner limits cannot be waived for obfuscated builds');
  output(opaque);const publication=await request('/api/catalog/projects/'+id,{title:'Never auto-safe',description:'',game:'',accessMode:'free',published:true,obfuscate:true,obfuscationLevel:'standard'});
  assert.equal(publication.status,202,JSON.stringify(publication.data));const job=await waitJob(f,id,publication.data.jobId,f.cookies[0]);
  check(job.status==='failed'&&job.error.code==='SECURITY_UNVERIFIED','Explicit public publication refuses opaque transformed output automatically');
  check((await f.pool.query('SELECT project_id FROM developer_listings WHERE project_id=$1 AND published_at IS NOT NULL',[id])).rows.length===0,'Held publication is not visible in the public catalogue');
  const encoded=crypto.encryptAES(opaque);
  await f.pool.query("UPDATE developer_scripts SET content_enc=$2,content_iv=$3,build_hash=$4,safety_status='approved',safety_hash=$5 WHERE project_id=$1",[id,encoded.enc,encoded.iv,crypto.sha256(opaque),'0'.repeat(64)]);
  output(opaque);const inconsistent=await submit('return 1',true);
  check(inconsistent.status==='failed'&&inconsistent.error.code==='SECURITY_UNVERIFIED','Previous approval metadata cannot waive automatic verification for an opaque build');
  console.log('Script publication safety: '+checks+' checks passed with real scans, isolated DB and simulated transforms; no user code execution.');
 }finally{builder.build=nativeBuild;await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
