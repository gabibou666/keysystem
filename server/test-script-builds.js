'use strict';
const {settleResponse,waitJob}=require('./tests/script-jobs');
const assert=require('node:assert/strict'),fs=require('fs/promises'),path=require('path'),os=require('os');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
  const f=await startFixture();let checks=0;
  const builder=require('./src/services/script-builder'),crypto=require('./src/services/crypto');
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('OK '+label);};
  async function req(url,method='GET',body,cookie=f.cookies[0]){
    const r=await fetch(f.base+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:f.base})},body:body===undefined?undefined:JSON.stringify(body)});
    return settleResponse(f,r,cookie);
  }
  try{
    const code='-- ORIGINAL_PRIVATE_COMMENT\nlocal privateVariableName: number = 4\nprivateVariableName += 2\nreturn privateVariableName';
    const built=await builder.build(code,{targetMode:'single',placeId:123,obfuscate:true,obfuscationLevel:'standard'});
    check(built.validated&&built.obfuscated&&built.targetMode==='single'&&built.placeId===123,'Luau is parsed and obfuscated with a single-place target');
    check(!built.code.includes('ORIGINAL_PRIVATE_COMMENT')&&!built.code.includes('privateVariableName')&&!built.code.includes(': number'),'Build strips comments, renames locals and removes type annotations');
    check(built.code.includes('assert(')&&/==\s*123/.test(built.code),'Single-place guard is embedded in generated code');
    check(await builder.validate(built.code),'Generated build passes a second parse');
    await assert.rejects(()=>builder.build('local x = ( PRIVATE_INVALID'),{code:'SCRIPT_INVALID'});checks++;console.log('OK Invalid syntax is rejected');
    for(const input of [{targetMode:'unknown'},{targetMode:'single',placeId:0},{targetMode:'single',placeId:1.5},{targetMode:'single',placeId:Number.MAX_SAFE_INTEGER+1},{targetMode:'universal',placeId:123}])await assert.rejects(()=>builder.build('return 1',input),{code:'SCRIPT_INVALID'});
    check(true,'Invalid and unsafe target values are rejected');
    const noExecution=await builder.build('while true do end');check(noExecution.validated,'Validation does not execute an infinite-loop user script');
    const concurrent=await Promise.allSettled([builder.build('return 1'),builder.build('return 2'),builder.build('return 3')]);
    check(concurrent[0].status==='fulfilled'&&concurrent[1].reason?.code==='SCRIPT_BUSY'&&concurrent[2].reason?.code==='SCRIPT_BUSY','One build runs at a time to preserve memory for the application');
    check((await builder.build('return 4')).validated,'Build capacity recovers after previous work completes');
    const id=(await req('/api/platform/projects','POST',{name:'Build verification'})).data.project.id;
    const refused=await req('/api/platform/projects/'+id+'/script','PUT',{content:code,targetMode:'single',placeId:123,obfuscate:true,obfuscationLevel:'standard'});
    check(refused.status===422&&refused.data.code==='SECURITY_UNVERIFIED','Opaque Standard output is refused without human approval');
    const upload=await req('/api/platform/projects/'+id+'/script','PUT',{content:code,targetMode:'single',placeId:123,obfuscate:false});
    check(upload.status===200&&upload.data.validated&&!upload.data.obfuscated&&upload.data.placeId===123,'Upload persists verified build flags and target');
    const stored=(await f.pool.query('SELECT * FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
    const decrypted=crypto.decryptAES(stored.content_enc,stored.content_iv);
    check(decrypted.includes('privateVariableName')&&stored.build_hash===crypto.sha256(decrypted)&&stored.scanner_version===require('./src/services/script-safety').SCANNER_VERSION,'Database encrypts automatically verified delivery with a current hash and scanner version');
    check(crypto.decryptAES(stored.original_content_enc,stored.original_content_iv)===code,'Original source is separately encrypted and preserved for its owner');
    const invalid=await req('/api/platform/projects/'+id+'/script','PUT',{content:'local x = ( PRIVATE_INVALID',targetMode:'universal'});
    check(invalid.status===400&&!JSON.stringify(invalid.data).includes('PRIVATE_INVALID')&&(await f.pool.query('SELECT version FROM developer_scripts WHERE project_id=$1',[id])).rows[0].version===1,'Rejected upload has generic error and preserves the previous version');
    const listing={title:'Built release',description:'',game:'A game',accessMode:'free',published:true,obfuscate:false,obfuscationLevel:'standard'};
    check((await req('/api/catalog/projects/'+id,'PUT',listing)).status===200,'Publication validates and rebuilds the owner original entirely automatically');
    const metadata=(await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing;
    check(metadata.validated&&!metadata.obfuscated&&metadata.targetMode==='single'&&metadata.placeId===123,'Public release metadata includes the verified target');
    const publicBuild=(await req('/api/catalog/scripts/'+id+'/source','GET',undefined,'')).data;
    const publishedStored=(await f.pool.query('SELECT content_enc,content_iv FROM developer_scripts WHERE project_id=$1',[id])).rows[0];
    check(publicBuild===crypto.decryptAES(publishedStored.content_enc,publishedStored.content_iv)&&publicBuild.includes('privateVariableName'),'Free release serves the newly rebuilt encrypted snapshot');
    await req('/api/platform/projects/'+id+'/script','PUT',{content:'return 7',targetMode:'universal'});
    check((await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing.placeId===123,'Free snapshot target stays unchanged after a private upload');
    await req('/api/catalog/projects/'+id,'PUT',{...listing,accessMode:'licensed',obfuscate:false});
    const universal=(await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing;
    check(universal.targetMode==='universal'&&universal.placeId===null&&universal.game==='Universal','Universal release removes any game-specific target');
    await req('/api/platform/projects/'+id+'/script','PUT',{content:'return 8',targetMode:'single',placeId:456});
    const live=(await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing;
    check(live.targetMode==='single'&&live.placeId===456&&live.scriptVersion===(await f.pool.query('SELECT version FROM developer_scripts WHERE project_id=$1',[id])).rows[0].version,'Licensed metadata follows the live loader target and version');
    const loader=await req('/api/platform/v1/loader/'+id,'GET',undefined,'');check(loader.data.includes('game.PlaceId == 456'),'Licensed loader checks the current Roblox place before requesting source');
    const originalEnc=crypto.encryptAES('local BROKEN_PUBLISH = (');
    await f.pool.query('UPDATE developer_scripts SET original_content_enc=$1,original_content_iv=$2 WHERE project_id=$3',[originalEnc.enc,originalEnc.iv,id]);
    check((await req('/api/catalog/projects/'+id,'PUT',{...listing,accessMode:'licensed',obfuscate:false})).status===400,'Publication detects a corrupt original even when the prior delivered build is valid');
    const legacy=crypto.encryptAES('return "legacy-raw-source"');
    await f.pool.query('UPDATE developer_scripts SET content_enc=$1,content_iv=$2,validated=false,obfuscated=false,original_content_enc=NULL,original_content_iv=NULL WHERE project_id=$3',[legacy.enc,legacy.iv,id]);
    check((await req('/api/catalog/projects/'+id,'PUT',listing)).status===409,'Legacy unvalidated upload must be rebuilt before publication');
    const key=(await req('/api/platform/projects/'+id+'/licenses','POST',{})).data.licenses[0].key;
    const denied=await req('/api/platform/v1/check','POST',{projectId:id,key,hwid:'test-build-device',loadScript:true},'');
    check(denied.data.reason==='build_required'&&!denied.data.script,'Legacy raw source is never delivered as a fallback');
    const modulePath=require.resolve('./src/services/script-builder'),installerPath=require.resolve('./scripts/install-darklua');
    const savedBuilder=require.cache[modulePath],savedInstaller=require.cache[installerPath];
    try{
      require.cache[installerPath]={...savedInstaller,exports:{...savedInstaller.exports,executable:path.join(os.tmpdir(),'does-not-exist-darklua-'+Date.now())}};
      delete require.cache[modulePath];const unavailable=require('./src/services/script-builder');
      await assert.rejects(()=>unavailable.build('return "PRIVATE_FALLBACK"'),{code:'SCRIPT_UNAVAILABLE'});check(true,'Missing parser fails closed without a source fallback');
    }finally{require.cache[modulePath]=savedBuilder;require.cache[installerPath]=savedInstaller;}
    const childProcess=require('child_process'),nativeSpawn=childProcess.spawn,dirs=new Set();
    try{
      childProcess.spawn=(exe,args,options)=>{if(options.cwd)dirs.add(options.cwd);return nativeSpawn(exe,args,options);};
      delete require.cache[modulePath];const tracked=require('./src/services/script-builder');
      await tracked.build('return 1');await assert.rejects(()=>tracked.build('local x = ('),{code:'SCRIPT_INVALID'});
      const remaining=await Promise.all([...dirs].map(dir=>fs.access(dir).then(()=>true,()=>false)));
      check(dirs.size>0&&remaining.every(exists=>!exists),'Temporary source directories are removed on success and parser failure');
    }finally{childProcess.spawn=nativeSpawn;require.cache[modulePath]=savedBuilder;}
    console.log(`Script builds: ${checks} checks passed using the pinned parser; no user script was executed.`);
  }finally{await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
