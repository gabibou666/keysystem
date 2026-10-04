'use strict';
const {settleResponse}=require('./tests/script-jobs');
const assert=require('node:assert/strict');
const {chromium}=require('@playwright/test');
const fs=require('fs'),path=require('path');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
  process.env.MODERATION_ADMIN_IDS='900000000000000001';
  const f=await startFixture(),browser=await chromium.launch({headless:true});
  const artifacts=path.join(__dirname,'../artifacts/moderation');fs.mkdirSync(artifacts,{recursive:true});
  let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log('OK '+label);};
  async function request(route,method='GET',body,index=1){
    const res=await fetch(f.base+route,{method,headers:{Cookie:f.cookies[index],Origin:f.base,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const result=await settleResponse(f,res,f.cookies[index]);assert.ok(result.status<400,JSON.stringify(result.data));return result.data;
  }
  async function context(index,width=1440){const c=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});await c.addCookies([{name:'ah_session',value:f.cookies[index].split('=')[1],url:f.base},...(index===0&&elevatedCookie?[{name:'ah_admin_session',value:elevatedCookie.split('=')[1],url:f.base}]:[])]);return c;}
  const errors=[];let elevatedCookie='';
  try{
    // A verified OWNER is required for the restricted journal. The activation
    // is explicit; a normal seven-day developer session never activates staff.
    await f.pool.query("INSERT INTO developer_identities(provider,subject,account_id,oauth_verified_at) VALUES('discord',$1,$2,$3)",[require('./src/services/staff-access').ownerDiscordId(),'900000000000000001',new Date()]);
    const activation=await fetch(f.base+'/admin/api/session',{method:'POST',headers:{Cookie:f.cookies[0],Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({confirmation:'ACTIVATE'})});
    assert.equal(activation.status,200);elevatedCookie=activation.headers.getSetCookie().find(value=>value.startsWith('ah_admin_session=')).split(';')[0];
    const id=(await request('/api/platform/projects','POST',{name:'Community release'})).project.id;
    await request('/api/platform/projects/'+id+'/script','PUT',{content:'return "initial release"'});
    await request('/api/catalog/me','PUT',{name:'Community creator',slug:'community-creator',description:'Independent scripts',discordUrl:'https://discord.gg/Community',websiteUrl:'https://example.com',avatarTheme:'prism',published:true});
    await request('/api/catalog/projects/'+id,'PUT',{title:'Mobile utilities',description:'Published release',game:'Universal',accessMode:'licensed',mobileSupport:'yes',published:true});
    const opaqueResponse=await fetch(f.base+'/api/platform/projects/'+id+'/script',{method:'PUT',headers:{Cookie:f.cookies[1],Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({content:'loadstring(game:HttpGet("https://example.com/script.lua"))()'})});
    const opaque=await settleResponse(f,opaqueResponse,f.cookies[1]);
    check(opaque.status===422&&opaque.data.code==='SECURITY_UNVERIFIED','Opaque release fails automatic security verification');
    check(!((await request('/api/platform/projects/'+id)).pendingSubmissions||[]).some(item=>item.status==='pending'),'Opaque release does not enter a human approval queue');
    const user=await context(1,390),page=await user.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.base+'/scripts/'+id);if(await page.locator('#cookieConsentReject').isVisible()) await page.locator('#cookieConsentReject').click();await page.locator('#publicScriptMobile').waitFor({state:'visible'});
    check((await page.locator('#publicScriptMobile').textContent()).includes('Yes'),'Mobile declaration appears publicly');
    check((await page.locator('#publicScriptKeys').textContent()).includes('Yes'),'License requirement appears publicly');
    check(await page.locator('#publicScriptDiscord').getAttribute('href')==='https://discord.gg/Community','Developer Discord appears on script');
    await page.locator('#reportCurrentScript').click();await page.locator('#scriptReportCategory').selectOption('privacy');await page.locator('#scriptReportDescription').fill('Unexpected private data collection');await page.locator('#scriptReportForm button').click();
    await page.getByText('Report sent to the moderators. Thank you for helping the community.',{exact:true}).waitFor();checks++;
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Script detail fits mobile width');
    await page.screenshot({path:path.join(artifacts,'script-mobile.png'),fullPage:true});
    await page.goto(f.base+'/developers/community-creator');if(await page.locator('#cookieConsentReject').isVisible()) await page.locator('#cookieConsentReject').click();await page.locator('#publicHubDiscord').waitFor({state:'visible'});
    check(await page.locator('#publicHubDiscord').getAttribute('href')==='https://discord.gg/Community','Public profile community link works');
    check(await page.locator('#publicHubWebsite').getAttribute('href')==='https://example.com/','Public profile website works');
    await page.screenshot({path:path.join(artifacts,'profile-mobile.png'),fullPage:true});
    await page.goto(f.base+'/moderation');if(await page.locator('#cookieConsentReject').isVisible()) await page.locator('#cookieConsentReject').click();await page.locator('#moderationDenied').waitFor({state:'visible'});
    check(!(await page.locator('#moderationWorkspace').isVisible()),'Ordinary developer cannot open moderator workspace');
    const admin=await context(0),mod=await admin.newPage();mod.on('pageerror',e=>errors.push(e.message));
    await mod.goto(f.base+'/moderation');if(await mod.locator('#cookieConsentReject').isVisible()) await mod.locator('#cookieConsentReject').click();await mod.locator('#moderationWorkspace').waitFor({state:'visible'});
    check(await mod.locator('#moderationTeamLink').isVisible()&&(await mod.locator('#moderationTeamLink').getAttribute('href')).startsWith('/admin'),'Staff management opens the central protected administration');
    check(await mod.locator('[data-decision="approve"]').count()===0&&await mod.locator('[data-decision="reject"]').count()===0,'Moderator UI has no release approval controls');
    check((await request('/api/platform/projects/'+id)).script.securityStatus==='clear','Automatic checks retain the active clear release');
    await mod.locator('[data-mod-tab="reports"]').click();await mod.getByText('Unexpected private data collection',{exact:true}).waitFor();
    await mod.locator('[data-resolve]').click();await mod.getByText('No records in this view.',{exact:true}).waitFor();checks++;
    await mod.locator('#moderationReportStatus').selectOption('resolved');await mod.getByText('Unexpected private data collection',{exact:true}).waitFor();checks++;
    await mod.locator('[data-mod-tab="audit"]').click();await mod.getByRole('heading',{name:'upload.clear',exact:true}).first().waitFor();
    const securityJournal=await mod.evaluate(async()=>{const response=await fetch('/admin/api/audit',{credentials:'same-origin'});if(!response.ok)throw Error('Restricted journal refused');return response.json();});
    check(securityJournal.items.some(item=>item.action==='report.processed'),'Report resolution is recorded in the restricted central security journal');
    await mod.screenshot({path:path.join(artifacts,'audit-desktop.png'),fullPage:true});
    const active=(await request('/api/platform/projects/'+id)).script;
    await mod.locator('#quarantineProject').fill(id);await mod.locator('#quarantineVersion').fill(String(active.version));await mod.locator('#quarantineHash').fill(active.securityHash);await mod.locator('#quarantineNote').fill('Suspicious behavior reported');
    await mod.locator('#quarantineForm button').click();await mod.getByText('Project quarantined.',{exact:true}).waitFor();
    check((await fetch(f.base+'/api/catalog/scripts/'+id)).status===404,'Quarantine removes public script access');
    await mod.setViewportSize({width:390,height:844});
    check(await mod.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Moderation dashboard fits mobile width');
    await mod.screenshot({path:path.join(artifacts,'moderation-mobile.png'),fullPage:true});
    check(errors.length===0,'Public and moderation pages have no browser errors');
    console.log(checks+' moderation/profile UI checks passed');
  }finally{await browser.close();await f.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
