'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = { projects: [], selected: '', detail: null, view: 'overview', revision: 0 };
  const names = { overview:'Overview', licenses:'Licenses', script:'Script hosting', checkpoints:'Checkpoints', settings:'Project settings', integration:'Integration' };
  const providerNames = {lootlabs:'LootLabs',workink:'Work.ink',linkvertise:'Linkvertise',linkunlocker:'LinkUnlocker'};
  function checkpointFields() {
    const provider = $('checkpointProvider').value, loot = provider === 'lootlabs', work = provider === 'workink';
    $('checkpointLinkField').hidden = loot; $('checkpointLinkIdField').hidden = !work;
    $('checkpointTokenField').hidden = work; $('checkpointCountField').hidden = !loot;
    $('linkvertiseTargetField').hidden = provider !== 'linkvertise';
    $('linkvertiseTargetUrl').value = state.selected ? location.origin + '/api/platform/checkpoints/' + state.selected + '/return' : '';
    $('checkpointLinkUrl').required = !loot; $('checkpointLinkId').required = work; $('checkpointToken').required = !work;
    $('checkpointTokenLabel').textContent = providerNames[provider] + ' API token';
    $('checkpointHelp').innerHTML = loot ? 'Set the returned postback URL in LootLabs. Include <code>unique_id</code> and <code>click_id</code> (the link’s <code>puid</code>).' :
      work ? 'Set your Work.ink link destination to any HTTPS page when creating it. This platform overrides the destination for each visitor and verifies the one-time token.' :
      provider === 'linkvertise' ? 'Use a Linkvertise Target Link. Set its destination to the target URL shown after saving. Paste your anti-bypassing token here.' :
      'Paste your LinkUnlocker link and Redirect API token. The platform encrypts a fresh destination for each visitor.';
  }
  const date = value => new Date(value).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
  async function api(path, method = 'GET', body) {
    const res = await fetch('/api/platform' + path, { method, headers: body === undefined ? {} : { 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({ error:'The server returned an unexpected response.' }));
    if (!res.ok || data.success === false) throw new Error(data.error || data.reason || 'Request failed');
    return data;
  }
  function message(text, error = false) {
    $('workspaceMessage').textContent = text; $('workspaceMessage').hidden = !text;
    $('workspaceMessage').className = 'message-bar' + (error ? ' error' : '');
  }
  function view(name) {
    state.view = name; $('breadcrumb').textContent = names[name];
    const needsProject = name !== 'overview' && !state.detail;
    document.querySelectorAll('[data-panel]').forEach(el => { el.hidden = el.dataset.panel !== name || needsProject; });
    document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === name); el.setAttribute('aria-current', el.dataset.view === name ? 'page' : 'false'); });
    $('projectRequired').hidden = !needsProject;
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
    $('projectGrid').innerHTML = state.projects.map(p => `<button type="button" class="project-card" data-project="${esc(p.id)}"><span class="feature-icon">◇</span><h3>${esc(p.name)}</h3><p>${p.licenses.toLocaleString()} licenses · ${p.validations.toLocaleString()} valid checks</p><div class="project-id">${esc(p.id)}</div></button>`).join('');
  }
  async function selectProject(id) {
    const revision = ++state.revision;
    if (id !== state.selected) { $('scriptForm').reset(); }
    state.selected = id; state.detail = null; $('projectSelect').value = id; view(state.view);
    if (!id) return;
    const detail = await api('/projects/' + id);
    if (revision !== state.revision) return;
    state.detail = detail;
    const p = detail.project;
    $('settingName').value = p.name; $('settingDescription').value = p.description;
    $('settingDuration').value = p.durationHours; $('settingHwid').checked = p.hwidBinding;
    $('licenseHours').value = p.durationHours; $('checkpointCount').value = p.checkpointCount;
    $('checkpointProvider').value = p.checkpointProvider || 'lootlabs'; $('checkpointLinkUrl').value = p.checkpointLinkUrl || ''; $('checkpointLinkId').value = p.checkpointLinkId || ''; checkpointFields();
    $('scriptVersion').textContent = detail.script ? 'Published · v' + detail.script.version : 'Not published';
    $('checkpointState').textContent = p.checkpointsConfigured ? providerNames[p.checkpointProvider] + ' connected' : 'Not configured';
    $('claimUrl').value = location.origin + '/claim?project=' + p.id;
    $('loaderSnippet').textContent = 'getgenv().AUDIT_KEY = "YOUR_LICENSE"\nloadstring(game:HttpGet(' + JSON.stringify(location.origin + '/api/platform/v1/loader/' + p.id) + '))()';
    $('licenseSummary').textContent = `${detail.stats.active} active / ${detail.stats.total} issued · Showing latest 100`;
    $('licensesBody').innerHTML = detail.licenses.length ? detail.licenses.map(l => {
      const expired = new Date(l.expires_at).getTime() <= Date.now();
      return `<tr><td class="mono">${esc(l.key_prefix)}…</td><td>${esc(l.note || '—')}</td><td>${esc(date(l.expires_at))}</td><td>${l.bound ? 'Bound' : 'Unbound'}</td><td><span class="status-pill ${l.revoked || expired ? 'status-bad' : 'status-good'}">${l.revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}</span></td><td><div class="row-actions"><button type="button" class="action-button" data-license="${esc(l.id)}" data-action="${l.revoked ? 'restore' : 'revoke'}">${l.revoked ? 'Restore' : 'Revoke'}</button><button type="button" class="action-button" data-license="${esc(l.id)}" data-action="reset-device">Reset device</button></div></td></tr>`;
    }).join('') : '<tr><td colspan="6">No licenses yet. Issue your first keys above.</td></tr>';
    $('eventsBody').innerHTML = detail.events.length ? detail.events.map(e => `<tr><td><span class="status-pill ${e.success ? 'status-good' : 'status-bad'}">${e.success ? 'Accepted' : 'Rejected'}</span></td><td class="mono">${esc(e.reason)}</td><td>${esc(e.executor || 'Unknown')}</td><td>${esc(date(e.created_at))}</td></tr>`).join('') : '<tr><td colspan="4">No validation activity yet.</td></tr>';
    view(state.view);
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
    } finally { element.disabled = false; }
  }
  function secret(title, value, explanation) {
    $('secretTitle').textContent = title; $('secretOutput').value = value;
    $('secretExplanation').textContent = explanation || 'Save this now. It is shown only once and cannot be retrieved later.';
    $('secretMessage').textContent = ''; $('secretDialog').showModal();
  }
  async function copy(text, target) {
    try { await navigator.clipboard.writeText(text); if (target) target.textContent = 'Copied.'; else message('Copied to clipboard.'); }
    catch { if (target) target.textContent = 'Clipboard unavailable. Select the text and copy it manually.'; else message('Clipboard unavailable. Select the text and copy it manually.', true); }
  }
  function bindForm(id, fn) {
    $(id).addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, fn); });
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
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
  $('scriptFile').addEventListener('change', async () => { const file = $('scriptFile').files[0]; if (!file) return; if (file.size > 1024*1024) return message('Your script must be smaller than 1 MB.',true); $('scriptContent').value = await file.text(); });
  bindForm('scriptForm', async () => { const d = await api('/projects/' + state.selected + '/script','PUT',{content:$('scriptContent').value}); await selectProject(state.selected); message('Script published: version ' + d.version + '.'); });
  $('checkpointProvider').addEventListener('change', checkpointFields);
  checkpointFields();
  bindForm('checkpointForm', async () => {
    const provider = $('checkpointProvider').value;
    const d = await api('/projects/' + state.selected + '/checkpoints','PUT',{
      provider,apiToken:$('checkpointToken').value,count:Number($('checkpointCount').value),
      linkUrl:$('checkpointLinkUrl').value.trim(),linkId:$('checkpointLinkId').value.trim(),
    });
    $('checkpointToken').value = '';
    if (d.postbackUrl) secret('LootLabs postback URL',d.postbackUrl,'Set this URL in LootLabs. Keep its secret private; saving again rotates it.');
    else if (d.targetUrl) secret('Linkvertise Target URL',d.targetUrl,'Set this exact URL as the destination of your Linkvertise Target Link.');
    else message(providerNames[provider] + ' configured. Share the public key page below.');
    await selectProject(state.selected);
  });
  $('copyClaimBtn').addEventListener('click', () => copy($('claimUrl').value));
  $('copyLinkvertiseTargetBtn').addEventListener('click', () => copy($('linkvertiseTargetUrl').value));
  $('copyLoaderBtn').addEventListener('click', () => copy($('loaderSnippet').textContent));
  $('rotateTokenBtn').addEventListener('click', event => {
    if (!confirm('Rotate this project API token? Requests using the current token will stop working immediately.')) return;
    busy(event.currentTarget, async () => { const d = await api('/projects/' + state.selected + '/token','POST',{}); secret('New API token',d.apiToken,'Replace the token in your backend. The previous token is now invalid.'); });
  });
  $('copySecretBtn').addEventListener('click', () => copy($('secretOutput').value,$('secretMessage')));
  $('downloadSecretBtn').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([$('secretOutput').value],{type:'text/plain'})); const a = document.createElement('a'); a.href=url; a.download='audit-hub-' + state.selected + '.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); });
  $('logoutBtn').addEventListener('click', event => busy(event.currentTarget, async () => { const r = await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); if (!r.ok) throw Error('Sign out failed.'); location.reload(); }));
  const login = new URLSearchParams(location.search).get('login');
  if (login && login !== 'ok') { $('loginMessage').textContent = login === 'denied' ? 'Discord sign-in was cancelled.' : 'Sign-in could not be completed. Please try again.'; $('loginMessage').hidden = false; }
  api('/me').then(async me => { if (!me.loggedIn) return; $('developerName').textContent=me.username || 'Developer'; $('loginView').hidden=true; $('workspaceView').hidden=false; await projects(); view('overview'); })
    .catch(e => { if (!$('workspaceView').hidden) message(e.message,true); else { $('loginMessage').textContent=e.message; $('loginMessage').hidden=false; } });
})();
