'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { chromium } = require('@playwright/test');
async function fixtureChild() {
  const { startFixture } = require('./tests/platform-fixture');
  const f = await startFixture();
  process.send({ base:f.base, cookie:f.cookies[0] });
  process.on('message', message => {
    if (message.type === 'legal') {
      process.env.LEGAL_NAME = message.name;
      process.env.LEGAL_EMAIL = message.email;
      process.env.LEGAL_ADDRESS = message.address;
      process.env.SUPPORT_EMAIL = 'support@example.com';
      process.env.DISCORD_URL = 'https://discord.gg/KdQwN99C9w';
      process.env.STATUS_URL = 'https://status.example.com/';
      process.send({ type:'legal-ready' });
    }
  });
  process.once('SIGTERM', async () => { await f.close(); process.exit(0); });
}
async function startIsolated() {
  const child = fork(__filename, ['--fixture'], { cwd:__dirname, env:{...process.env,NODE_ENV:'test',SUPPORT_EMAIL:'',DISCORD_URL:'',STATUS_URL:'',LEGAL_NAME:'',LEGAL_EMAIL:'',LEGAL_ADDRESS:'',MODERATION_ADMIN_IDS:''}, stdio:['ignore','ignore','pipe','ipc'] });
  let errors=''; child.stderr.on('data', chunk => { errors=(errors+chunk).slice(-4000); });
  const info=await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{child.kill();reject(Error('Fixture startup timeout: '+errors));},20000);
    child.once('message', message=>{clearTimeout(timer);resolve(message);});
    child.once('exit', code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+': '+errors));});
  });
  return {...info,configure:()=>new Promise(resolve=>{
    const receive=message=>{if(message.type==='legal-ready'){child.off('message',receive);resolve();}};
    child.on('message',receive);child.send({type:'legal',name:'Test publisher <script>window.unwanted = true</script>',email:'privacy@example.com',address:'Test publisher address'});
  }),close:()=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill();})};
}
async function run() {
  const f=await startIsolated(); const browser=await chromium.launch({headless:true});
  let checks=0; const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('OK '+label);};
  const errors=[],policyErrors=[],external=[];
  const artifacts=path.join(__dirname,'../artifacts/legal');fs.mkdirSync(artifacts,{recursive:true});
  async function context(locale,width=1440) {
    const c=await browser.newContext({locale,viewport:{width,height:width===360?800:1000},reducedMotion:'reduce'});
    c.on('page',p=>{
      p.on('pageerror',e=>errors.push(e.message));
      p.on('console',m=>{if(m.type()==='error'&&/content.security|refused to/i.test(m.text()))policyErrors.push(m.text());});
      p.on('request',r=>{if(!r.url().startsWith(f.base)&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))external.push(r.url());});
    });return c;
  }
  async function noOverflow(p,label) {check(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' has no page overflow');}
  try {
    const c=await context('fr-FR',360),page=await c.newPage();
    await page.goto(f.base,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>document.documentElement.lang==='fr');
    const buttons=await page.locator('.cookie-consent-actions button').evaluateAll(nodes=>nodes.map(n=>{const s=getComputedStyle(n);return{color:s.color,background:s.backgroundColor,border:s.borderColor,width:Math.round(n.getBoundingClientRect().width)};}));
    check(buttons.length===3&&buttons.every(b=>JSON.stringify(b)===JSON.stringify(buttons[0])),'Three consent choices have equal visual importance');
    check(await page.locator('#cookieConsentBanner').getAttribute('role')==='region','Consent is an accessible non-modal region');
    check(await page.evaluate(()=>window.AuditHubConsent.getState().optional)===false,'Optional storage is disabled before a choice');
    await noOverflow(page,'French consent at 360 px');
    await page.screenshot({path:path.join(artifacts,'cookies-mobile-fr.png')});
    await page.locator('#cookieConsentCustomize').click();
    check(await page.locator('#cookieConsentNecessary').isChecked()&&await page.locator('#cookieConsentNecessary').isDisabled()&&!(await page.locator('#cookieConsentOptional').isChecked()),'Preference categories preserve necessary storage and optional default off');
    await page.locator('#cookieConsentReject').click();
    await page.reload({waitUntil:'networkidle'});
    check(!(await page.locator('#cookieConsentBanner').isVisible()),'Refusal persists across reload');
    await page.locator('[data-manage-cookies]').click();
    check(await page.locator('#cookieConsentTitle').evaluate(n=>n===document.activeElement),'Footer preferences receive accessible focus');
    await page.keyboard.press('Escape');
    check(await page.locator('[data-manage-cookies]').evaluate(n=>n===document.activeElement),'Escape restores focus to the footer');
    for(const route of ['/privacy','/terms','/cookies','/legal']) {
      const response=await page.goto(f.base+route,{waitUntil:'networkidle'});
      check(response.status()===200&&response.headers()['content-security-policy'].includes("script-src 'self'"),route+' is accessible with strict security headers');
      check(await page.locator('html').getAttribute('lang')==='fr'&&await page.locator('[data-legal-locale="fr"]').isVisible()&&!(await page.locator('[data-legal-locale="en"]').isVisible()),route+' displays French using saved language');
      await noOverflow(page,route+' at 360 px');
      check((await page.locator('[data-legal-locale="fr"] .legal-updated').first().innerText()).includes('4 octobre 2026'),route+' displays its update date');
    }
    check((await page.locator('[data-legal-locale="fr"] .legal-placeholder').count())>=3,'Publisher identity fields remain visibly marked when empty');
    await page.locator('[data-legal-language]').selectOption('en');
    check(await page.locator('html').getAttribute('lang')==='en'&&await page.locator('[data-manage-cookies]').innerText()==='Manage my cookies','Legal language selector also updates the shared footer');
    await page.locator('[data-manage-cookies]').click();
    check(await page.locator('#cookieConsentTitle').innerText()==='Cookie preferences','Legal language selector also updates consent preferences');
    await page.locator('.cookie-consent-close').click();
    await f.configure();
    // Configuration is intentionally browser-cached for five minutes. Refresh
    // that cache after changing only the isolated test process environment.
    await page.evaluate(() => fetch('/api/site/config', { cache:'reload' }).then(r => r.json()));
    await page.reload({waitUntil:'networkidle'});
    const identity=page.locator('[data-legal-locale="en"] [data-legal-value="legalName"]');
    check((await identity.innerText()).includes('<script>')&&await page.evaluate(()=>!window.unwanted),'Configured publisher name is rendered as inert text');
    check(await page.locator('[data-legal-locale="en"] [data-legal-contact] a').first().getAttribute('href')==='mailto:privacy@example.com','Privacy contact uses configured legal email');
    check(await page.locator('[data-footer-support]').isVisible()&&await page.locator('footer [data-contact="status"]').isVisible(),'Configured support and status appear in their footer columns');
    const copy=await page.locator('.site-footer-bottom').innerText();check(copy==='© 2026 AUDIT HUB. Independent of Roblox.','Copyright and Roblox independence are preserved');
    await page.screenshot({path:path.join(artifacts,'legal-mobile-en.png')});
    await page.goto(f.base+'/signup',{waitUntil:'networkidle'});
    const terms=page.locator('#acceptedTerms');
    check(await terms.count()===1&&await terms.getAttribute('required')!==null&&!(await terms.isChecked()),'Signup requires explicit unchecked acceptance');
    check(await page.locator('.auth-terms-choice a[href="/terms"]').count()===1&&await page.locator('.auth-terms-choice a[href="/privacy"]').count()===1,'Signup acceptance links to both policies');
    const desktop=await context('fr-FR');const dashboard=await desktop.newPage();
    const [cookieName,cookieValue]=f.cookie.split('=');
    await desktop.addCookies([{name:cookieName,value:cookieValue,url:f.base,httpOnly:true,sameSite:'Lax'}]);
    await dashboard.goto(f.base+'/dashboard',{waitUntil:'networkidle'});
    await dashboard.locator('#cookieConsentReject').click();
    await dashboard.locator('[data-view="account"]').click();
    check(await dashboard.locator('#accountPanel').isVisible(),'Account controls are available with an empty workspace');
    const download=dashboard.waitForEvent('download');await dashboard.locator('#exportAccountBtn').click();
    const file=await download;const exportPath=path.join(artifacts,'fixture-account-export.json');await file.saveAs(exportPath);
    const exported=JSON.parse(fs.readFileSync(exportPath,'utf8'));
    check(file.suggestedFilename().endsWith('.json')&&exported&&typeof exported==='object','Dashboard downloads a real JSON account export');
    await dashboard.screenshot({path:path.join(artifacts,'account-desktop-fr.png')});
    await dashboard.locator('#openDeleteAccountBtn').click();
    check(await dashboard.locator('#deleteAccountDialog').isVisible()&&!(await dashboard.locator('#confirmDeleteAccountBtn').isEnabled()),'Deletion opens a confirmation and is initially disabled');
    await dashboard.locator('#deleteAccountConfirmation').fill('delete');
    check(!(await dashboard.locator('#confirmDeleteAccountBtn').isEnabled()),'Incorrect confirmation cannot submit deletion');
    await dashboard.locator('#cancelDeleteAccountBtn').click();
    check(await dashboard.locator('#openDeleteAccountBtn').evaluate(n=>n===document.activeElement),'Cancelling deletion restores focus without deleting');
    await dashboard.setViewportSize({width:360,height:800});await noOverflow(dashboard,'Account controls at 360 px');
    check(await dashboard.getByRole('button', {name:'Compte et données',exact:true}).isVisible(), 'Account navigation keeps its visible accessible name at 360 px');
    await dashboard.locator('#openDeleteAccountBtn').click();await noOverflow(dashboard,'Deletion confirmation at 360 px');
    await dashboard.screenshot({path:path.join(artifacts,'account-delete-mobile-fr.png')});
    await dashboard.locator('#deleteAccountConfirmation').fill('DELETE');
    const deletion=dashboard.waitForResponse(r=>new URL(r.url()).pathname==='/api/account'&&r.request().method()==='DELETE');
    await dashboard.locator('#confirmDeleteAccountBtn').click();check((await deletion).status()===200,'Confirmed deletion removes only the isolated fixture account');
    await dashboard.waitForURL(f.base+'/?account=deleted');
    check((await dashboard.request.get(f.base+'/api/platform/me')).ok()&&!((await (await dashboard.request.get(f.base+'/api/platform/me')).json()).loggedIn),'Deleted account session is revoked');
    const generic=await context('de-DE',360),en=await generic.newPage();await en.goto(f.base+'/cookies',{waitUntil:'networkidle'});
    check(await en.locator('html').getAttribute('lang')==='en','Unsupported browser languages default to English policies');
    await noOverflow(en,'English cookies policy at 360 px');
    check(external.length===0,'No external analytics, pixel, script or request is loaded during the complete browser flow');
    check(errors.length===0&&policyErrors.length===0,'No browser JavaScript or CSP errors');
    console.log('Legal and account UI: '+checks+' checks passed using isolated synthetic data.');
  } finally {await browser.close();await f.close();}
}
if(process.argv.includes('--fixture'))fixtureChild().catch(e=>{console.error(e);process.exit(1);});
else run().catch(e=>{console.error(e);process.exitCode=1;});
