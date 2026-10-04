'use strict';
const {settleResponse}=require('./tests/script-jobs');
const assert=require('node:assert/strict');
const parse=require('luaparse').parse;
const {startFixture}=require('./tests/platform-fixture');
async function run(){
  const f=await startFixture();let checks=0;
  const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('OK '+label);};
  async function req(path,method='GET',body,cookie=f.cookies[0],extra={}){
    const response=await fetch(f.base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:f.base}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    return settleResponse(f,response,cookie);
  }
  try{
    const created=await req('/api/platform/projects','POST',{name:'PRIVATE_GUI_NAME'});
    const id=created.data.project.id,path='/api/platform/projects/'+id;
    check(created.data.project.keyUiMode==='custom'&&created.data.project.keyUiButtonSize==='medium','Existing/custom GUI behavior is the default');
    const options={keyUiMode:'builtin',keyUiLayout:'sidebar',keyUiColor:'rose',keyUiButtonSize:'large'};
    check((await req(path+'/key-ui','PUT',options, f.cookies[1])).status===404,'Another developer cannot change the GUI');
    check((await req(path+'/key-ui','PUT',options,'')).status===401,'Anonymous GUI mutation is rejected');
    check((await req(path+'/key-ui','PUT',options,f.cookies[0],{Origin:'https://attacker.example'})).status===403,'Cross-origin GUI mutation is rejected');
    for(const [field,value] of Object.entries({keyUiMode:'external',keyUiLayout:'<script>',keyUiColor:'https://library.example/code',keyUiButtonSize:999})){
      check((await req(path+'/key-ui','PUT',{...options,[field]:value})).status===400,'Rejects invalid '+field);
    }
    const saved=await req(path+'/key-ui','PUT',options);
    check(saved.status===200&&Object.entries(options).every(([k,v])=>saved.data.project[k]===v),'Owner saves all GUI options');
    check(Object.entries(options).every(([k,v])=>(saved.data.project[k]===(v))),'GUI response uses agreed fields');
    const detail=(await req(path)).data;
    check(Object.entries(options).every(([k,v])=>detail.project[k]===v),'Saved GUI configuration survives project reload');
    await req(path+'/script','PUT',{content:'return 42',targetMode:'single',placeId:123});
    const secret='GUI_PROVIDER_TOKEN_DO_NOT_LEAK';
    await req(path+'/checkpoints','PUT',{provider:'lootlabs',apiToken:secret,checkpointCount:1});
    const sdk=await req('/api/platform/v1/sdk/'+id,'GET',undefined,'');
    parse(sdk.data,{luaVersion:'5.3'});
    check(sdk.status===200&&sdk.data.includes('function client.validate(key)')&&sdk.data.includes('function client.load(key)')&&sdk.data.includes('function client.getKeyUrl()'),'Public SDK parses and exports dot-call methods');
    check(sdk.data.includes('check(key, false)')&&sdk.data.includes('pcall(check, key, true)')&&sdk.data.includes('data.success~=true')&&sdk.data.includes('game.PlaceId == 123'),'Validation-only and loading share server validation and game guard');
    check(sdk.data.includes('task.defer(')&&sdk.data.includes('already_loaded'),'Loading schedules execution after return and prevents repeats');
    check(!sdk.data.includes(secret)&&!sdk.data.includes(created.data.apiToken)&&!sdk.data.includes('PRIVATE_GUI_NAME')&&!sdk.data.includes('AUDIT_KEY'),'SDK exposes no developer token, private name or global key storage');
    check(sdk.headers.get('cache-control')==='no-store','SDK is not cached');
    let variants=0;
    for(const keyUiLayout of ['compact','card','sidebar'])for(const keyUiColor of ['violet','blue','green','rose','amber'])for(const keyUiButtonSize of ['small','medium','large']){
      const code=require('./src/services/platform-loader').loader(id,f.base,{...options,keyUiLayout,keyUiColor,keyUiButtonSize,claimUrl:f.base+'/claim?project='+id});
      parse(code,{luaVersion:'5.3'});variants++;
      assert.ok(!code.includes('AUDIT_KEY')&&!code.includes('HttpGet('));
    }
    check(variants===45,'All 45 built-in variants parse with no remote GUI library or persistent key');
    const loader=await req('/api/platform/v1/loader/'+id,'GET',undefined,'');
    parse(loader.data,{luaVersion:'5.3'});
    check(loader.data.includes('local layout="sidebar"')&&loader.data.includes('Color3.fromRGB(244,63,94)')&&loader.data.includes('local buttonHeight=48'),'Public loader uses persisted presentation, color and button size');
    check(loader.data.includes('setclipboard')&&loader.data.includes('link.Visible=true'),'Get-key button has a selectable-link fallback');
    check(loader.data.includes('client.load,input.Text')&&loader.data.includes('busy=false')&&loader.data.includes('input.Text="" close()'),'Built-in GUI retries failed checks and clears the key on success');
    const key=(await req(path+'/licenses','POST',{})).data.licenses[0].key;
    const denied=await req('/api/platform/v1/check','POST',{projectId:id,key:'invalid',hwid:'gui-test-device',loadScript:true},'');
    check(denied.data.success===false&&!denied.data.script,'GUI configuration cannot bypass invalid-key validation');
    const validated=await req('/api/platform/v1/check','POST',{projectId:id,key,hwid:'gui-test-device',loadScript:false},'');
    check(validated.data.success===true&&!validated.data.script,'Validation-only check never returns source');
    const allowed=await req('/api/platform/v1/check','POST',{projectId:id,key,hwid:'gui-test-device',loadScript:true},'');
    check(allowed.data.success===true&&typeof allowed.data.script==='string','Valid key unlocks the checked build');
    const listing={title:'Public GUI script',description:'',game:'Test',accessMode:'licensed',published:true};
    await req('/api/catalog/projects/'+id,'PUT',listing);
    const publicListing=(await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing;
    check(publicListing.keyUiMode==='builtin'&&!('keyUiColor' in publicListing),'Licensed catalogue exposes only the required GUI mode');
    await req('/api/catalog/projects/'+id,'PUT',{...listing,accessMode:'free'});
    check(!('keyUiMode' in (await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing),'Free scripts do not advertise a key GUI');
    await req(path+'/key-ui','PUT',{...options,keyUiMode:'custom'});
    const legacy=(await req('/api/platform/v1/loader/'+id,'GET',undefined,'')).data;
    parse(legacy,{luaVersion:'5.3'});
    check(legacy.includes('env.AUDIT_KEY')&&!legacy.includes('Instance.new'),'Custom mode retains the existing AUDIT_KEY loader');
    check((await req('/api/platform/v1/sdk/not-a-uuid','GET',undefined,'')).status===404,'Invalid SDK project is rejected');
    console.log('Key UI: '+checks+' checks passed.');
  }finally{await f.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
