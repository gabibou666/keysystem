'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const assetVersion = new URL(document.querySelector('script[src*="app-dashboard.js"]').src).searchParams.get('v') || '';
  const icon = name => `<img class="workspace-icon" src="/icons/${name}.svg?v=${encodeURIComponent(assetVersion)}" width="18" height="18" alt="" aria-hidden="true">`;
  const buttonLabel = (id,label,name) => { $(id).innerHTML = icon(name) + esc(label); };
  const state = { projects: [], selected: '', detail: null, view: 'overview', revision: 0, checkpointEditing: false, publicHub:null, listings:[], username:'' };
  const scripts = window.AuditHubScripts.create({api,catalogApi,message,view,selectedPlaceId,onComplete:async projectId=>{
    if(projectId!==state.selected) return;
    await selectProject(projectId); await loadPublicHub();
  }});
  const names = { overview:'Overview', publichub:'Publish scripts', licenses:'Licenses', script:'Script hosting', checkpoints:'Checkpoints', settings:'Project settings', integration:'Integration', account:'Account & data' };
  const providerNames = {lootlabs:'LootLabs',workink:'Work.ink',linkvertise:'Linkvertise',linkunlocker:'LinkUnlocker'};
  function checkpointFields() {
    const provider = $('checkpointProvider').value, loot = provider === 'lootlabs', work = provider === 'workink';
    const project = state.detail?.project;
    const saved = project?.checkpointsConfigured && provider === project.checkpointProvider;
    const connected = !!project?.checkpointsConfigured;
    $('checkpointEditor').hidden = connected && !state.checkpointEditing;
    $('checkpointResult').hidden = !connected || state.checkpointEditing;
    $('cancelCheckpointEditBtn').hidden = !connected;
    $('editCheckpointBtn').setAttribute('aria-expanded', String(state.checkpointEditing));
    $('checkpointEditorTitle').textContent = connected ? 'Change your connection' : 'Connect your provider';
    $('checkpointProviderHint').textContent = loot ? 'Paste your LootLabs token. We create the links for each user.' :
      work ? 'Paste your Work.ink link and its ID. No API token or callback to set up.' :
      provider === 'linkvertise' ? 'Create your Target Link below, then paste its link and anti-bypassing token.' :
      'Paste your LinkUnlocker link and Redirect API token. The return link is automatic.';
    const tasks = project?.checkpointProvider === 'lootlabs' ? project.checkpointCount : 1;
    $('checkpointConnectionSummary').textContent = connected ? providerNames[project.checkpointProvider] + ' / ' + tasks + (tasks === 1 ? ' task' : ' tasks') + ' / ' + project.durationHours + '-hour keys' : '';
    $('checkpointLinkField').hidden = loot; $('checkpointLinkIdField').hidden = !work;
    $('checkpointTokenField').hidden = work; $('checkpointCountField').hidden = !loot;
    $('linkvertiseTargetField').hidden = provider !== 'linkvertise';
    $('linkvertiseTargetUrl').value = state.selected ? location.origin + '/api/platform/checkpoints/' + state.selected + '/return' : '';
    $('checkpointLinkUrl').required = !loot; $('checkpointLinkId').required = work; $('checkpointToken').required = !work && !saved;
    $('checkpointToken').placeholder = saved ? 'Already saved — leave blank to keep it' : 'Paste your API token';
    $('checkpointTokenHint').textContent = saved ? 'Your token is saved securely. Enter a new one only to replace it.' : 'Copy this from your provider account. You only need to enter it once.';
    $('checkpointTokenLabel').textContent = providerNames[provider] + ' API token';
    const setup = project?.checkpointSetup;
    $('checkpointCallbackField').hidden = !connected;
    $('checkpointCallbackUrl').value = connected && setup?.url || '';
    $('checkpointCallbackLabel').textContent = setup?.label || 'Provider callback';
    buttonLabel('copyCheckpointCallbackBtn',setup?.kind === 'dynamic-redirect' ? 'Copy endpoint' : 'Copy callback','copy');
    $('checkpointCallbackTitle').textContent = setup?.automatic ? 'Your callback is handled automatically' : 'Add your callback to ' + providerNames[project?.checkpointProvider || provider];
    $('checkpointHelp').textContent = setup?.instruction || 'Save your connection to get the callback.';
    $('checkpointProviderGuide').href = setup?.docsUrl || '/docs#checkpoints';
    $('checkpointProviderGuide').textContent = 'Official ' + providerNames[project?.checkpointProvider || provider] + ' setup guide';
    $('checkpointCallbackDetails').textContent = setup?.kind === 'postback' ? 'The click_id identifies the session using the link\'s puid. unique_id identifies each completed task. Both are required; duplicate task receipts are ignored.' : setup?.kind === 'dynamic-redirect' ? 'The endpoint is not a complete destination. The platform adds private per-session parameters, encrypts the destination with LinkUnlocker, and validates it after the browser returns.' : 'Users must start on your public key page and return in the same browser. The platform verifies the provider proof before issuing a key.';
    $('copyCheckpointCallbackBtn').disabled = !$('checkpointCallbackUrl').value;
    $('checkpointDestinationTitle').textContent = 'Connection saved';
    $('checkpointShareHint').textContent = loot ? 'After adding the callback in LootLabs, test this page once. Then share it with your users.' : 'Test this page once, then share it with your users. It handles the tasks and gives them their key.';
    $('testCheckpointLink').href = state.selected ? location.origin + '/claim?project=' + state.selected : '/dashboard';
  }
  const date = value => new Date(value).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
  async function api(path, method = 'GET', body) {
    const res = await fetch('/api/platform' + path, { method, headers: body === undefined ? {} : { 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({ error:'The server returned an unexpected response.' }));
    if (!res.ok || data.success === false) throw new Error(data.error || data.reason || 'Request failed');
    return data;
  }
  async function catalogApi(path, method = 'GET', body) {
    const response = await fetch('/api/catalog' + path, {method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data = await response.json().catch(()=>({error:'Unexpected catalogue response.'}));
    if(!response.ok || data.success===false) throw Error(data.error || 'Publication failed.');
    return data;
  }
  function listingHint() {
    const free = $('listingAccessMode').value === 'free';
    $('listingFreeConsentField').hidden = !free; $('listingFreeConsent').required=free;
    $('listingKeyUiOptions').hidden=free;
    const project=state.detail?.project;
    $('listingKeyUiHint').textContent=project?.keyUiMode==='builtin'?'Key interface: AUDIT HUB / '+project.keyUiLayout+' / '+project.keyUiColor+' / '+project.keyUiButtonSize+' buttons.':'Key interface: your own GUI via the SDK, or the standard loader with a supplied license.';
    $('listingAccessHint').textContent = free ? 'Free access makes the released build public. Anyone can download and copy it without a license.' : 'Visitors get your loader and use a project license. The released build is delivered after license validation.';
  }
  function targetFields() {
    const single = $('scriptTargetMode').value === 'single';
    $('scriptPlaceField').hidden=!single; $('scriptPlaceId').required=single;
    if(!single) $('scriptPlaceId').value='';
  }
  function keyUiFields() {
    const builtin=$('keyUiMode').value==='builtin';
    $('keyUiAppearance').hidden=!builtin;
    $('keyUiHint').textContent=builtin?'Players run your loader, enter their key in the included GUI and validate it.':'Connect your GUI with the client SDK in the documentation, or set AUDIT_KEY before running the loader.';
    $('keyUiPreview').dataset.layout=$('keyUiLayout').value;
    $('keyUiPreview').dataset.color=$('keyUiColor').value;
    $('keyUiPreview').dataset.size=$('keyUiButtonSize').value;
  }
  function selectedPlaceId() {
    let value = $('scriptPlaceId').value.trim();
    if(!/^\d+$/.test(value)) {
      try {
        const url = new URL(value);
        if(url.protocol!=='https:' || !['roblox.com','www.roblox.com'].includes(url.hostname) || url.username || url.password || url.port) throw Error();
        value = /^\/games\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] || '';
      } catch { value=''; }
    }
    const id = Number(value);
    if(!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id<1) throw Error('Paste a Roblox game URL or a positive Place ID.');
    return id;
  }
  function listingFields() {
    const project = state.detail?.project;
    const listing = state.listings.find(l=>l.projectId===state.selected);
    $('listingNoProject').hidden = !!project; $('publicListingForm').hidden = !project;
    $('listingPublicationState').textContent = !project ? 'Choose a project' : listing?.published ? 'Published' : 'Not published';
    if(!project) return;
    $('listingTitle').value = listing?.title || project.name;
    $('listingGame').value = listing?.game || '';
    const universal = (state.detail.script?.targetMode || 'universal') === 'universal';
    $('listingGame').disabled=universal;
    if(universal) $('listingGame').value='Universal';
    $('listingDescription').value = listing?.description || '';
    $('listingMobileSupport').value=listing?.mobileSupport || 'unknown';
    $('listingAccessMode').value = listing?.accessMode || 'licensed'; $('listingFreeConsent').checked=false; listingHint();
    $('listingPrerequisite').hidden = !!state.detail.script;
    $('publishListingBtn').disabled = !state.detail.script || state.detail.script.originalAvailable===false;
    buttonLabel('publishListingBtn',listing?.published ? 'Update public release' : 'Publish this script','upload');
    $('unpublishListingBtn').hidden = !listing?.published;
    const visible = !!listing?.published && !!state.publicHub?.published;
    $('openPublicListing').hidden = !visible; $('openPublicListing').href='/scripts/'+project.id;
    $('listingVisibilityHint').textContent = !state.publicHub ? 'Publish your first script directly. A developer profile is created automatically.' : !state.publicHub.published ? 'Your developer profile is private. Make it public in the optional profile settings to show your scripts.' : listing?.published ? 'This script is visible in the public catalogue.' : 'This project is private until you publish this listing.';
    scripts.syncActions();
  }
  async function loadPublicHub() {
    const data = await catalogApi('/me'); state.publicHub=data.hub; state.listings=data.listings;
    $('hubProfileName').value=data.hub?.name || '';
    $('hubProfileSlug').value=data.hub?.slug || '';
    $('hubProfileDescription').value=data.hub?.description || '';
    $('hubProfileDiscord').value=data.hub?.discordUrl || ''; $('hubProfileWebsite').value=data.hub?.websiteUrl || ''; $('hubProfileAvatar').value=data.hub?.avatarTheme || 'orbit';
    $('hubProfilePublished').checked=!!data.hub?.published;
    $('hubPublicationState').textContent=data.hub?.published ? 'Public' : 'Private';
    $('openPublicHub').hidden=!data.hub?.published; $('copyPublicHubLink').hidden=!data.hub?.published;
    $('openPublicHub').href=data.hub ? '/developers/'+encodeURIComponent(data.hub.slug) : '/scripts';
    listingFields();
  }
  function message(text, error = false) {
    $('workspaceMessage').textContent = text; $('workspaceMessage').hidden = !text;
    $('workspaceMessage').className = 'message-bar' + (error ? ' error' : '');
  }
  function view(name) {
    state.view = name; $('breadcrumb').textContent = names[name];
    const needsProject = !['overview','publichub','account'].includes(name) && !state.detail;
    document.querySelectorAll('[data-panel]').forEach(el => { el.hidden = el.dataset.panel !== name || needsProject; });
    document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === name); el.setAttribute('aria-current', el.dataset.view === name ? 'page' : 'false'); });
    $('projectRequired').hidden = !needsProject;
    scripts.setView(name);
  }
  async function projects() {
    const data = await api('/projects'); state.projects = data.projects;
    $('projectSelect').innerHTML = '<option value="">Choose a project</option>' + state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if (!state.projects.some(p => p.id === state.selected)) { state.selected = ''; state.detail = null; }
    $('projectSelect').value = state.selected;
    $('projectCount').textContent = state.projects.length;
    $('licenseCount').textContent = state.projects.reduce((n,p) => n + p.licenses, 0).toLocaleString();
    $('validationCount').textContent = state.projects.reduce((n,p) => n + p.validations, 0).toLocaleString();
    $('noProjects').hidden = state.projects.length > 0;
    $('projectGrid').innerHTML = state.projects.map(p => `<button type="button" class="project-card" data-project="${esc(p.id)}"><div class="project-card-top"><span class="feature-icon">${icon('folder')}</span>${icon('external')}</div><h3>${esc(p.name)}</h3><p>${Number(p.views||0).toLocaleString()} views / ${Number(p.executions||0).toLocaleString()} executions / ${p.licenses.toLocaleString()} licenses · ${p.validations.toLocaleString()} valid checks</p><div class="project-id">${esc(p.id)}</div></button>`).join('');
  }
  async function selectProject(id) {
    const revision = ++state.revision;
    if (id !== state.selected) { clearSensitiveFields(); $('scriptForm').reset(); $('checkpointCopyMessage').textContent = ''; $('checkpointShareMessage').textContent = ''; state.checkpointEditing = false; $('checkpointCountField').open = false; }
    state.selected = id; state.detail = null; $('projectSelect').value = id; view(state.view);
    if (!id) { listingFields(); await scripts.setProject(null,state.username); return; }
    const detail = await api('/projects/' + id);
    if (revision !== state.revision) return;
    state.detail = detail;
    let metrics=$('projectScriptMetrics');if(!metrics){metrics=document.createElement('p');metrics.id='projectScriptMetrics';metrics.className='notice';$('scriptSafetyState').before(metrics);}
    metrics.textContent=Number(detail.metrics?.views||0).toLocaleString()+' views · '+Number(detail.metrics?.executions||0).toLocaleString()+' executions (script deliveries). Invalid keys and validation-only checks are excluded.';
    const p = detail.project;
    $('keyUiMode').value=p.keyUiMode || 'custom'; $('keyUiLayout').value=p.keyUiLayout || 'compact'; $('keyUiColor').value=p.keyUiColor || 'violet'; $('keyUiButtonSize').value=p.keyUiButtonSize || 'medium'; keyUiFields();
    $('settingName').value = p.name; $('settingDescription').value = p.description;
    $('settingDuration').value = p.durationHours; $('settingHwid').checked = p.hwidBinding;
    $('licenseHours').value = p.durationHours; $('checkpointCount').value = p.checkpointCount;
    $('checkpointProvider').value = p.checkpointProvider || 'lootlabs'; $('checkpointLinkUrl').value = p.checkpointLinkUrl || ''; $('checkpointLinkId').value = p.checkpointLinkId || ''; checkpointFields();
    $('scriptVersion').textContent = detail.script ? 'Published · v' + detail.script.version : 'Not published';
    if(detail.script?.validated) $('scriptVersion').textContent += ' · Checked';
    const pending=detail.pendingSubmissions?.filter(s=>s.status==='pending').length||0;
    $('scriptSafetyState').textContent=pending?pending+' release(s) waiting for moderator review. Your active version remains unchanged.':detail.script?.securityStatus==='quarantined'?'This project is quarantined. Its script delivery is blocked.':detail.script?.securityStatus==='approved'?'Active release approved by a moderator. This does not certify every runtime behavior.':detail.script?.securityStatus==='clear'?'Automated checks found no flagged behavior. This is not a guarantee of safety.':'New uploads and their output are checked locally. Unknown or opaque behavior is held for review.';
    if(detail.securityChecks?.length){const check=detail.securityChecks[0];$('scriptSafetyState').textContent+=' Last automatic recheck: '+date(check.checkedAt)+' / '+check.result+'.';}
    $('scriptTargetMode').value=detail.script?.targetMode || 'universal';
    $('scriptPlaceId').value=detail.script?.placeId || ''; targetFields();
    $('checkpointState').textContent = p.checkpointsConfigured ? providerNames[p.checkpointProvider] + ' connected' : 'Not configured';
    $('claimUrl').value = location.origin + '/claim?project=' + p.id;
    $('loaderSnippet').textContent = 'getgenv().AUDIT_KEY = "YOUR_LICENSE"\nloadstring(game:HttpGet(' + JSON.stringify(location.origin + '/api/platform/v1/loader/' + p.id) + '))()';
    if(p.keyUiMode==='builtin') $('loaderSnippet').textContent='loadstring(game:HttpGet('+JSON.stringify(location.origin+'/api/platform/v1/loader/'+p.id)+'))()';
    $('licenseSummary').textContent = `${detail.stats.active} active / ${detail.stats.total} issued · Showing latest 100`;
    $('licensesBody').innerHTML = detail.licenses.length ? detail.licenses.map(l => {
      const expired = new Date(l.expires_at).getTime() <= Date.now();
      return `<tr><td class="mono">${esc(l.key_prefix)}…</td><td>${esc(l.note || '—')}</td><td>${esc(date(l.expires_at))}</td><td>${l.bound ? 'Bound' : 'Unbound'}</td><td><span class="status-pill ${l.revoked || expired ? 'status-bad' : 'status-good'}">${l.revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}</span></td><td><div class="row-actions"><button type="button" class="action-button" data-license="${esc(l.id)}" data-action="${l.revoked ? 'restore' : 'revoke'}">${l.revoked ? 'Restore' : 'Revoke'}</button><button type="button" class="action-button" data-license="${esc(l.id)}" data-action="reset-device">Reset device</button></div></td></tr>`;
    }).join('') : '<tr><td colspan="6">No licenses yet. Issue your first keys above.</td></tr>';
    $('eventsBody').innerHTML = detail.events.length ? detail.events.map(e => `<tr><td><span class="status-pill ${e.success ? 'status-good' : 'status-bad'}">${e.success ? 'Accepted' : 'Rejected'}</span></td><td class="mono">${esc(e.reason)}</td><td>${esc(e.executor || 'Unknown')}</td><td>${esc(date(e.created_at))}</td></tr>`).join('') : '<tr><td colspan="4">No validation activity yet.</td></tr>';
    listingFields(); view(state.view); await scripts.setProject(detail,state.username);
  }
  async function busy(element, fn) {
    if (element.disabled) return;
    element.disabled = true; message('');
    try { await fn(); } catch (e) {
      message(e.message, true);
      // Keep failures visible when a form is displayed in a modal.
      const dialog = element.closest('dialog');
      if (dialog?.open) {
        let error = dialog.querySelector('[data-form-error]');
        if (!error) { error = document.createElement('p'); error.dataset.formError = ''; error.className = 'message-bar error'; error.setAttribute('role','alert'); dialog.append(error); }
        error.textContent = e.message;
      }
    } finally { element.disabled = false; scripts.syncActions(); }
  }
  function secret(title, value, explanation) {
    $('secretTitle').textContent = title; $('secretOutput').value = value;
    $('secretExplanation').textContent = explanation || 'Save this now. It is shown only once and cannot be retrieved later.';
    $('secretMessage').textContent = ''; $('secretDialog').showModal();
  }
  function clearSensitiveFields() {
    if ($('secretDialog').open) $('secretDialog').close();
    ['secretOutput','checkpointToken','checkpointCallbackUrl','scriptContent'].forEach(id => { $(id).value = ''; });
    scripts.clear();
  }
  window.addEventListener('pagehide', clearSensitiveFields);
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  async function copy(text, target) {
    try { await navigator.clipboard.writeText(text); if (target) target.textContent = 'Copied.'; else message('Copied to clipboard.'); }
    catch { if (target) target.textContent = 'Clipboard unavailable. Select the text and copy it manually.'; else message('Clipboard unavailable. Select the text and copy it manually.', true); }
  }
  function bindForm(id, fn) {
    $(id).addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, fn); });
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
  $('chooseListingKeyUi').addEventListener('click',()=>{view('script');$('keyUiMode').focus();});
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $('secretDialog').addEventListener('close', () => { $('secretOutput').value = ''; });
  ['newProjectBtn','firstProjectBtn'].forEach(id => $(id).addEventListener('click', () => { $('projectForm').reset(); $('projectDialog').querySelector('[data-form-error]')?.remove(); $('projectDialog').showModal(); }));
  $('backOverviewBtn').addEventListener('click', () => view('overview'));
  $('projectSelect').addEventListener('change', () => selectProject($('projectSelect').value).catch(e => message(e.message,true)));
  $('projectGrid').addEventListener('click', event => { const button = event.target.closest('[data-project]'); if (button) { view('licenses'); selectProject(button.dataset.project).catch(e => message(e.message,true)); } });
  bindForm('projectForm', async () => {
    const d = await api('/projects','POST',{ name:$('projectName').value.trim() });
    $('projectDialog').close(); state.selected = d.project.id;
    secret('Project API token',d.apiToken,'Keep this token on your backend. Never include it in the Lua loader or share it with players.');
    await projects(); await selectProject(state.selected); view('integration');
  });
  $('issueLicenseBtn').addEventListener('click', () => { $('licenseDialog').querySelector('[data-form-error]')?.remove(); $('licenseDialog').showModal(); });
  bindForm('licenseForm', async () => {
    const d = await api('/projects/' + state.selected + '/licenses','POST',{ durationHours:Number($('licenseHours').value), count:Number($('licenseQuantity').value), note:$('licenseNote').value });
    $('licenseDialog').close(); secret('Save your licenses',d.licenses.map(l=>l.key).join('\n')); await projects(); await selectProject(state.selected);
  });
  $('licensesBody').addEventListener('click', event => {
    const button = event.target.closest('[data-license]'); if (!button) return;
    busy(button, async () => { await api('/projects/' + state.selected + '/licenses/' + button.dataset.license + '/' + button.dataset.action,'POST',{}); await selectProject(state.selected); message('License updated.'); });
  });
  bindForm('settingsForm', async () => { await api('/projects/' + state.selected,'PATCH',{ name:$('settingName').value, description:$('settingDescription').value, durationHours:Number($('settingDuration').value), hwidBinding:$('settingHwid').checked }); await projects(); await selectProject(state.selected); message('Project settings saved.'); });
  bindForm('hubProfileForm', async()=>{
    await catalogApi('/me','PUT',{name:$('hubProfileName').value.trim(),slug:$('hubProfileSlug').value.trim(),description:$('hubProfileDescription').value,published:$('hubProfilePublished').checked,discordUrl:$('hubProfileDiscord').value.trim(),websiteUrl:$('hubProfileWebsite').value.trim(),avatarTheme:$('hubProfileAvatar').value});
    await loadPublicHub(); message(state.publicHub.published ? 'Developer profile saved publicly.' : 'Developer profile saved privately.');
  });
  const listingBody = published => ({title:$('listingTitle').value.trim(),description:$('listingDescription').value,game:$('listingGame').value.trim(),accessMode:$('listingAccessMode').value,mobileSupport:$('listingMobileSupport').value,published});
  bindForm('publicListingForm',async()=>{await scripts.publish(listingBody(true));});
  $('listingAccessMode').addEventListener('change',()=>{ $('listingFreeConsent').checked=false; listingHint(); });
  $('scriptTargetMode').addEventListener('change',targetFields);
  ['keyUiMode','keyUiLayout','keyUiColor','keyUiButtonSize'].forEach(id=>$(id).addEventListener('change',keyUiFields));
  bindForm('keyUiForm',async()=>{await api('/projects/'+state.selected+'/key-ui','PUT',{keyUiMode:$('keyUiMode').value,keyUiLayout:$('keyUiLayout').value,keyUiColor:$('keyUiColor').value,keyUiButtonSize:$('keyUiButtonSize').value});await selectProject(state.selected);message('Key interface saved. Your loader URL stays the same.');});
  $('unpublishListingBtn').addEventListener('click',event=>busy(event.currentTarget,async()=>{await catalogApi('/projects/'+state.selected,'PUT',listingBody(false));await loadPublicHub();message('Script unpublished. Previously downloaded copies remain with their users.');}));
  $('copyPublicHubLink').addEventListener('click',()=>copy(location.origin+$('openPublicHub').getAttribute('href'),$('hubProfileCopyMessage')));
  $('checkpointProvider').addEventListener('change', checkpointFields);
  $('editCheckpointBtn').addEventListener('click', () => { state.checkpointEditing = true; checkpointFields(); $('checkpointProvider').focus(); });
  $('cancelCheckpointEditBtn').addEventListener('click', () => { state.checkpointEditing = false; $('checkpointToken').value = ''; $('checkpointProvider').value = state.detail.project.checkpointProvider; $('checkpointLinkUrl').value = state.detail.project.checkpointLinkUrl || ''; $('checkpointLinkId').value = state.detail.project.checkpointLinkId || ''; $('checkpointCount').value = state.detail.project.checkpointCount; checkpointFields(); $('editCheckpointBtn').focus(); });
  checkpointFields();
  bindForm('checkpointForm', async () => {
    const provider = $('checkpointProvider').value;
    const d = await api('/projects/' + state.selected + '/checkpoints','PUT',{
      provider,apiToken:$('checkpointToken').value,count:Number($('checkpointCount').value),
      linkUrl:$('checkpointLinkUrl').value.trim(),linkId:$('checkpointLinkId').value.trim(),
    });
    $('checkpointToken').value = '';
    state.checkpointEditing = false;
    $('checkpointCopyMessage').textContent = ''; $('checkpointShareMessage').textContent = '';
    await selectProject(state.selected);
    message(providerNames[provider] + ' saved. ' + (d.postbackUrl ? 'Add the callback in LootLabs, then test your user link.' : 'Your user link is below. Test it before sharing.'));
    $(d.postbackUrl ? 'copyCheckpointCallbackBtn' : 'copyClaimBtn').focus();
  });
  $('copyClaimBtn').addEventListener('click', () => copy($('claimUrl').value,$('checkpointShareMessage')));
  $('copyCheckpointCallbackBtn').addEventListener('click', () => copy($('checkpointCallbackUrl').value,$('checkpointCopyMessage')));
  $('copyLinkvertiseTargetBtn').addEventListener('click', () => copy($('linkvertiseTargetUrl').value));
  $('copyLoaderBtn').addEventListener('click', () => copy($('loaderSnippet').textContent));
  $('rotateTokenBtn').addEventListener('click', event => {
    if (!confirm('Rotate this project API token? Requests using the current token will stop working immediately.')) return;
    busy(event.currentTarget, async () => { const d = await api('/projects/' + state.selected + '/token','POST',{}); secret('New API token',d.apiToken,'Replace the token in your backend. The previous token is now invalid.'); });
  });
  $('copySecretBtn').addEventListener('click', () => copy($('secretOutput').value,$('secretMessage')));
  $('downloadSecretBtn').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([$('secretOutput').value],{type:'text/plain'})); const a = document.createElement('a'); a.href=url; a.download='audit-hub-' + state.selected + '.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); });
  $('logoutBtn').addEventListener('click', event => busy(event.currentTarget, async () => { const r = await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); if (!r.ok) throw Error('Sign out failed.'); location.reload(); }));
  function showWarnings(warnings) {
    const section = $('accountWarnings');
    if (!Array.isArray(warnings) || !warnings.length) return;
    let language = navigator.language || 'en';
    try { language = localStorage.getItem('audit-hub-language') || language; } catch { /* Storage is optional. */ }
    const french = language.startsWith('fr');
    section.setAttribute('aria-label', french ? 'Messages de l’équipe du site' : 'Messages from the site team');
    const title = document.createElement('h2');
    title.textContent = french ? 'Message de l’équipe du site' : 'A message from the site team';
    section.replaceChildren(title);
    warnings.forEach(warning => {
      const line = document.createElement('p');
      line.textContent = warning.reason;
      const when = document.createElement('small');
      when.textContent = date(warning.created_at);
      line.append(document.createElement('br'), when);
      section.append(line);
    });
    section.hidden = false;
  }
  const login = new URLSearchParams(location.search).get('login');
  if (login && login !== 'ok') { $('loginMessage').textContent = login === 'denied' ? 'Discord sign-in was cancelled.' : 'Sign-in could not be completed. Please try again.'; $('loginMessage').hidden = false; }
  api('/me').then(async me => { if (!me.loggedIn) return; state.username=me.username || 'Developer'; $('moderationLink').hidden=!me.canModerate; $('discordBotLink').hidden=!me.canManageBot; showWarnings(me.warnings); $('developerName').textContent=state.username; $('loginView').hidden=true; $('workspaceView').hidden=false; await projects(); await loadPublicHub(); const initialView = new URLSearchParams(location.search).get('view'); view(['publichub','account'].includes(initialView) ? initialView : 'overview'); })
    .catch(e => { if (!$('workspaceView').hidden) message(e.message,true); else { $('loginMessage').textContent=e.message; $('loginMessage').hidden=false; } });
})();
