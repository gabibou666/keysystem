'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = { page:1, pages:1, revision:0 };
  function loaderSnippet() {
    const key = $('publicLicenseInput')?.value.trim();
    $('publicLoaderSnippet').textContent = (state.licensed && !state.builtin ? 'getgenv().AUDIT_KEY = ' + JSON.stringify(key || 'YOUR_LICENSE') + '\n' : '') + 'loadstring(game:HttpGet(' + JSON.stringify(state.loaderUrl) + '))()';
  }
  const assetVersion = new URL(document.querySelector('script[src*="app-catalog.js"]').src).searchParams.get('v') || '';
  async function api(path) {
    const response = await fetch('/api/catalog' + path);
    const data = await response.json();
    if (!response.ok || data.success === false) throw Error(data.error || 'This page is unavailable.');
    return data;
  }
  function message(text) { $('catalogMessage').textContent = text; $('catalogMessage').hidden = !text; }
  function title(text) { document.title = text + ' — AUDIT HUB'; document.querySelector('link[rel="canonical"]').href = location.origin + location.pathname; }
  const date = value => new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
  const covers = ['orbit','circuit','prism'];
  const mobileLabel=l=>l.mobileSupport==='yes'?'Mobile: Yes':l.mobileSupport==='no'?'Mobile: No':'Mobile: Not declared';
  const safetyLabel=l=>l.securityStatus==='approved'?'Moderator approved':l.securityStatus==='clear'?'Analysis: no alert detected':'Security check pending';
  function publicLink(id,value,discord=false){
    const element=$(id);element.hidden=true;element.removeAttribute('href');
    if(!value)return;
    try{
      const url=new URL(value);
      if(url.protocol!=='https:'||url.username||url.password||url.port)return;
      if(discord && !((url.hostname==='discord.gg'&&/^\/[a-zA-Z0-9-]{2,100}\/?$/.test(url.pathname))||(url.hostname==='discord.com'&&/^\/invite\/[a-zA-Z0-9-]{2,100}\/?$/.test(url.pathname))))return;
      element.href=url.href;element.hidden=false;
    }catch{}
  }
  const targetLabel = l => l.targetMode === 'single' ? (l.game || 'Roblox place') + ' / Place ' + l.placeId : l.targetMode === 'universal' ? 'Universal' : l.game || 'Lua script';
  const theme = value => [...String(value)].reduce((sum,c)=>(sum*31+c.charCodeAt(0))>>>0,7)%covers.length;
  const cover = value => '/assets/covers/'+covers[theme(value)]+'.svg?v='+encodeURIComponent(assetVersion);
  const icon = name => {
    const paths = {arrow:'M7 17 17 7M7 7h10v10',code:'m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',user:'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',key:'M14 10a5 5 0 1 1 0-1M14 10l7 7m-3-3-3 3'};
    return `<svg class="catalog-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]||paths.code}"/></svg>`;
  };
  function scriptCards(listings) {
    return listings.map(l => `<a class="catalog-card catalog-script-card" href="/scripts/${encodeURIComponent(l.projectId)}"><div class="catalog-cover"><img src="${cover(l.projectId)}" alt="" loading="lazy" decoding="async" width="800" height="320"><span class="catalog-cover-label">${icon('code')} LUA RELEASE</span><span class="status-pill catalog-cover-badge">${l.accessMode === 'free' ? 'Free access' : 'License required'}</span></div><div class="catalog-card-body"><span class="catalog-game">${escape(targetLabel(l))}</span><div class="catalog-script-meta"><span class="status-pill">${escape(mobileLabel(l))}</span><span class="status-pill">Key system: ${l.hasKeySystem?"Yes":"No"}</span><span class="status-pill">${escape(safetyLabel(l))}</span></div><h3>${escape(l.title)}</h3><p class="catalog-card-description">${escape(l.description)}</p><div class="catalog-card-footer"><span>${icon('user')} ${escape(l.author)}</span><span>Open script ${icon('arrow')}</span></div></div></a>`).join('');
  }
  async function browse(page = 1) {
    const revision = ++state.revision;
    message(''); $('catalogCount').textContent = 'Loading...';
    const params = new URLSearchParams({q:$('catalogSearch').value.trim(),sort:$('catalogSort').value,page:String(page)});
    const data = await api('/scripts?' + params);
    if (revision !== state.revision) return;
    state.page = data.page; state.pages = data.pages;
    $('catalogGrid').innerHTML = scriptCards(data.listings);
    $('catalogCount').textContent = data.total + (data.total === 1 ? ' script' : ' scripts');
    $('catalogEmpty').hidden = data.listings.length > 0;
    const filtered = !!$('catalogSearch').value.trim();
    $('catalogEmptyTitle').textContent = filtered ? 'No scripts found.' : 'Publish the first script.';
    $('catalogEmptyText').textContent = filtered ? 'Try another script title, creator or game.' : 'Published scripts will appear here. Create your developer account to share your first release.';
    $('catalogPagination').hidden = data.pages <= 1;
    $('catalogPrevious').disabled = state.page <= 1; $('catalogNext').disabled = state.page >= state.pages;
    $('catalogPageLabel').textContent = 'Page ' + state.page + ' of ' + state.pages;
  }
  async function hub(slug) {
    $('catalogBrowse').hidden = true;
    const {hub:h,listings} = await api('/hubs/' + encodeURIComponent(slug));
    title(h.name); $('publicHubName').textContent = h.name; $('publicHubAuthor').textContent = 'by ' + h.author;
    $('publicHubDescription').textContent = h.description; $('hubMonogram').textContent = h.name.slice(0,2).toUpperCase();
    const avatar=covers.includes(h.avatarTheme)?h.avatarTheme:'orbit';
    $('publicHubCoverImage').src='/assets/covers/'+avatar+'.svg?v='+encodeURIComponent(assetVersion); $('hubMonogram').className='catalog-avatar catalog-theme-'+covers.indexOf(avatar);
    $('publicHubJoined').textContent=h.joinedAt?'Profile created '+date(h.joinedAt):'';
    publicLink('publicHubDiscord',h.discordUrl,true);publicLink('publicHubWebsite',h.websiteUrl);
    $('publicHubScripts').innerHTML = scriptCards(listings); $('hubScriptCount').textContent = listings.length + (listings.length === 1 ? ' script' : ' scripts');
    $('hubNoScripts').hidden = listings.length > 0; $('catalogHub').hidden = false;
  }
  async function script(id) {
    $('catalogBrowse').hidden = true;
    const {listing:l} = await api('/scripts/' + encodeURIComponent(id));
    title(l.title); $('publicScriptTitle').textContent = l.title; $('publicScriptAuthor').textContent = 'by ' + l.author + ' / ' + l.hubName;
    $('publicScriptDescription').textContent = l.description; $('publicScriptGame').textContent = targetLabel(l);
    $('publicScriptCoverImage').src=cover(l.projectId);
    $('publicScriptAccess').textContent = l.accessMode === 'free' ? 'Free access' : 'License required';
    $('publicScriptMobile').textContent=mobileLabel(l);$('publicScriptKeys').textContent=l.hasKeySystem?'Key system: Yes':'Key system: No';$('publicScriptSafety').textContent=safetyLabel(l);
    $('publicScriptSafetyHint').textContent='Mobile support is declared by the developer. Security checks and moderator approval do not guarantee that a script is harmless. Obfuscated code can hide behavior; report anything suspicious.';
    publicLink('publicScriptDiscord',l.discordUrl,true);state.projectId=l.projectId;
    $('publicScriptUpdated').textContent = 'Updated ' + date(l.updatedAt); $('scriptHubLink').href = '/developers/' + encodeURIComponent(l.hubSlug);
    // Only same-origin URLs from the public API become executable loader links.
    const loader = new URL(l.loaderUrl, location.origin);
    if (loader.origin !== location.origin) throw Error('Invalid loader destination.');
    state.loaderUrl = loader.href; state.licensed = l.accessMode !== 'free'; state.builtin=state.licensed && l.keyUiMode==='builtin';
    if (state.licensed && !state.builtin) {
      const field = document.createElement('label'); field.className='field';
      const label = document.createElement('span'); label.textContent='Your license key';
      const input = document.createElement('input'); input.id='publicLicenseInput'; input.className='p-input'; input.type='password'; input.autocomplete='off'; input.maxLength=512; input.placeholder='Paste your key, then copy your loader'; input.spellcheck=false;
      const hint = document.createElement('small'); hint.textContent='Kept only in this page until you leave. Copying the loader includes your key: keep it private.';
      field.append(label,input,hint); $('publicLoaderSnippet').before(field);
      input.addEventListener('input',()=>{loaderSnippet();$('publicLoaderMessage').textContent='';});
    }
    loaderSnippet();
    $('publicLoaderHint').textContent = l.accessMode === 'free' ? 'Copy the loader, paste it in your executor and run it.' : l.claimUrl ? 'Get a key below, paste it here, then copy your ready-to-run loader.' : 'Contact this developer for a license, paste it here, then copy your ready-to-run loader.';
    if(state.builtin) $('publicLoaderHint').textContent='Copy and run the loader. The included GUI will ask for your key in-game.';
    if (l.claimUrl) { const claim = new URL(l.claimUrl,location.origin); if(claim.origin !== location.origin) throw Error('Invalid key page.'); $('publicGetKey').href=claim.href; $('publicGetKey').hidden=false; }
    $('catalogScript').hidden = false;
  }
  $('catalogSearchForm').addEventListener('submit', event => {event.preventDefault();browse().catch(e=>message(e.message));});
  $('catalogSort').addEventListener('change',()=>browse().catch(e=>message(e.message)));
  $('catalogPrevious').addEventListener('click',()=>browse(state.page-1).catch(e=>message(e.message)));
  $('catalogNext').addEventListener('click',()=>browse(state.page+1).catch(e=>message(e.message)));
  $('scriptReportForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try{
      const response=await fetch('/api/moderation/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:state.projectId,category:$('scriptReportCategory').value,description:$('scriptReportDescription').value})});
      const data=await response.json();if(!response.ok)throw Error(response.status===401?'Sign in before submitting a report.':data.error||'Report could not be sent.');
      $('scriptReportDescription').value='';$('scriptReportMessage').textContent='Report sent to the moderators.';
    }catch(error){$('scriptReportMessage').textContent=error.message;}finally{button.disabled=false;}
  });
  $('copyPublicLoader').addEventListener('click',async()=>{
    if(state.licensed && !state.builtin && !$('publicLicenseInput').value.trim()) { $('publicLoaderMessage').textContent='Paste your license key first.'; $('publicLicenseInput').focus(); return; }
    try{await navigator.clipboard.writeText($('publicLoaderSnippet').textContent);$('publicLoaderMessage').textContent='Copied.';}catch{$('publicLoaderMessage').textContent='Select the loader and copy it manually.';}
  });
  window.addEventListener('pagehide',()=>{ if($('publicLicenseInput')) $('publicLicenseInput').value=''; $('publicLoaderSnippet').textContent=''; });
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  const route = location.pathname.replace(/\/$/,'').split('/');
  const task = route[1] === 'scripts' && route[2] ? script(route[2]) : ['hubs','developers'].includes(route[1]) && route[2] ? hub(route[2]) : browse();
  task.catch(e=>message(e.message));
})();
