'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { startFixture } = require('./tests/platform-fixture');

async function run() {
 const fixture = await startFixture();
 const browser = await chromium.launch({headless:true});
 try {
  const context = await browser.newContext({locale:'en-US',viewport:{width:360,height:800}});
  await context.addCookies([{name:'ah_session',value:fixture.cookies[0].slice('ah_session='.length),url:fixture.base}]);
  const response = await fetch(fixture.base+'/api/platform/projects',{method:'POST',headers:{Cookie:fixture.cookies[0],Origin:fixture.base,'Content-Type':'application/json'},body:JSON.stringify({name:'Finding diagnostics'})});
  assert.equal(response.status,201);
  const project = (await response.json()).project;
  const page = await context.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.base+'/dashboard');
  await page.locator('#workspaceView').waitFor({state:'visible'});
  await page.locator('#cookieConsentReject').click();
  await page.locator('#projectSelect').selectOption(project.id);
  await page.locator('[data-view="script"]').click();
  await page.locator('#scriptContent').fill('os.execute("PRIVATE_PAYLOAD_NEVER_EXECUTED")');
  await page.locator('#publishScriptBtn').click();
  await page.locator('#scriptJobStatus').getByText('Failed',{exact:true}).waitFor();
  const panel=page.locator('#scriptJobSecurity');
  assert.match(await panel.textContent(),/process_execution · line 1/);
  assert.match(await panel.textContent(),/not proof of malicious intent/);
  assert.ok(!(await panel.textContent()).includes('PRIVATE_PAYLOAD_NEVER_EXECUTED'));
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('audit-hub:language',{detail:{language:'fr'}})));
  assert.match(await panel.textContent(),/ligne 1/);
  assert.match(await panel.textContent(),/preuve de malveillance/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('audit-hub:language',{detail:{language:'en'}})));
  await page.locator('#scriptContent').fill('local key=readfile("local-cache.json"); assert(key); return game:HttpGet("https://example.invalid/ui.lua")');
  await page.locator('#publishScriptBtn').click();
  await page.locator('#scriptJobStatus').getByText('Awaiting review',{exact:true}).waitFor();
  assert.match(await panel.textContent(),/sensitive_network_transfer · line 1/);
  assert.match(await panel.textContent(),/does not establish that the data is transmitted/);
  assert.equal(await page.locator('#scriptJobError').isVisible(),false);
  const detail=await fetch(fixture.base+'/api/platform/projects/'+project.id,{headers:{Cookie:fixture.cookies[0]}});
  assert.equal((await detail.json()).script,null,'A review cannot create an active release');
  assert.deepEqual(errors,[]);
  console.log('Script finding UI: blocked/review diagnostics, private payload exclusion, EN/FR and mobile passed.');
 } finally { await browser.close(); await fixture.close(); }
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;});
