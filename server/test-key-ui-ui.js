'use strict';
const assert=require('node:assert/strict');
const {chromium}=require('@playwright/test');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
  const fixture=await startFixture(),browser=await chromium.launch();
  require('fs').mkdirSync(require('path').resolve(__dirname,'../artifacts/platform'),{recursive:true});
  async function api(path,method='GET',body){
    const response=await fetch(fixture.base+path,{method,headers:{Cookie:fixture.cookies[0],...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;
  }
  try{
    const id=(await api('/api/platform/projects','POST',{name:'Interface project'})).project.id;
    await api('/api/platform/projects/'+id+'/script','PUT',{content:'return "interface test"'});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'ah_session',value:fixture.cookies[0].split('=')[1],url:fixture.base}]);
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(fixture.base+'/dashboard');await page.locator('#projectSelect').selectOption(id);
    await page.locator('[data-view="script"]').click();
    await page.locator('#scriptVersion').getByText('Published',{exact:false}).waitFor();
    assert.equal(await page.locator('#keyUiMode').inputValue(),'custom');
    assert.equal(await page.locator('#keyUiAppearance').isVisible(),false);
    await page.locator('#keyUiMode').selectOption('builtin');
    for(const layout of ['compact','card','sidebar']){
      await page.locator('#keyUiLayout').selectOption(layout);
      for(const color of ['violet','blue','green','rose','amber']){
        await page.locator('#keyUiColor').selectOption(color);
        assert.equal(await page.locator('#keyUiPreview').getAttribute('data-layout'),layout);
        assert.equal(await page.locator('#keyUiPreview').getAttribute('data-color'),color);
      }
    }
    await page.locator('#keyUiButtonSize').selectOption('small');
    const small=await page.locator('.key-ui-preview-actions b').evaluate(el=>el.getBoundingClientRect().height);
    await page.locator('#keyUiButtonSize').selectOption('large');
    const large=await page.locator('.key-ui-preview-actions b').evaluate(el=>el.getBoundingClientRect().height);
    assert.ok(large>small,'Button size updates the actual preview dimensions');
    await page.locator('#keyUiForm button[type="submit"]').click();await page.getByText('Key interface saved.',{exact:false}).waitFor();
    const saved=(await api('/api/platform/projects/'+id)).project;
    assert.equal(saved.keyUiMode,'builtin');assert.equal(saved.keyUiLayout,'sidebar');assert.equal(saved.keyUiColor,'amber');assert.equal(saved.keyUiButtonSize,'large');
    await page.locator('[data-view="integration"]').click();
    assert.doesNotMatch(await page.locator('#loaderSnippet').textContent(),/AUDIT_KEY/,'Built-in loader does not require key edits');
    await page.locator('[data-view="publichub"]').click();
    assert.match(await page.locator('#listingKeyUiHint').textContent(),/AUDIT HUB.*sidebar.*amber.*large/,'Publication shows the chosen interface');
    await page.locator('#chooseListingKeyUi').click();
    assert.equal(await page.locator('#keyUiMode').evaluate(el=>el===document.activeElement),true,'Publisher can open the interface choices directly');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Interface editor fits mobile');
    await page.screenshot({path:require('path').resolve(__dirname,'../artifacts/platform/key-interface-mobile.png'),fullPage:true});
    await api('/api/catalog/projects/'+id,'PUT',{title:'Interface release',description:'',game:'Universal',accessMode:'licensed',published:true});
    await page.goto(fixture.base+'/scripts/'+id);await page.locator('#publicLoaderSnippet').waitFor({state:'visible'});
    assert.equal(await page.locator('#publicLicenseInput').count(),0,'Built-in GUI collects the license in game');
    await page.locator('#copyPublicLoader').click();await page.locator('#publicLoaderMessage').getByText('Copied.',{exact:true}).waitFor();
    assert.doesNotMatch(await page.evaluate(()=>navigator.clipboard.readText()),/AUDIT_KEY|YOUR_LICENSE/);
    await api('/api/platform/projects/'+id+'/key-ui','PUT',{keyUiMode:'custom',keyUiLayout:'card',keyUiColor:'rose',keyUiButtonSize:'medium'});
    await page.reload();await page.locator('#publicLicenseInput').waitFor({state:'visible'});
    await page.goto(fixture.base+'/docs#custom-gui');await page.locator('#custom-gui').waitFor();
    assert.match(await page.locator('article').textContent(),/client\.load\(keyText\)/);
    assert.deepEqual(errors,[]);
    console.log('Key interface UI: modes, 15 layout/color previews, button sizing, saved config, loader variants, mobile and custom GUI documentation passed.');
  }finally{await browser.close();await fixture.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
