'use strict';
(()=>{
  const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={tab:'queue',page:1,pages:1,items:[],revision:0};
  function message(text,error=false){$('moderationMessage').hidden=!text;$('moderationMessage').textContent=text;$('moderationMessage').className='message-bar'+(error?' error':'');}
  async function api(path,method='GET',body){
    const response=await fetch('/api/moderation'+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data=await response.json().catch(()=>({error:'Unexpected server response.'}));
    if(!response.ok)throw Error(data.error||'Request refused.');return data;
  }
  const date=value=>new Date(value).toLocaleString();
  async function overview(){const data=await api('/overview');$('moderationPending').textContent=data.pending;$('moderationReports').textContent=data.reports;$('moderationQuarantined').textContent=data.quarantined;}
  function render(item){
    if(state.tab==='queue')return `<article class="moderation-item"><h3>Held release / v${esc(item.version)}</h3><p class="mono">Project ${esc(item.projectId)}</p><p class="muted-copy">${esc(item.hash)} / ${esc(date(item.createdAt))}</p><span class="status-pill">${esc(item.status)}</span><ul>${(item.findings||[]).map(f=>`<li>${esc(f.severity)} / ${esc(f.rule)} / line ${esc(f.line)}</li>`).join('')}</ul><label class="field"><span>Decision note (no secrets or code)</span><input class="p-input" data-note="${esc(item.id)}" maxlength="500"></label><div class="checkpoint-actions"><button class="action-button" data-decision="approve" data-id="${esc(item.id)}" type="button">Approve this release</button><button class="action-button" data-decision="reject" data-id="${esc(item.id)}" type="button">Reject release</button></div></article>`;
    if(state.tab==='reports')return `<article class="moderation-item"><h3>${esc(item.category)}</h3><p class="mono">Project ${esc(item.projectId)}</p><p>${esc(item.description||'No additional detail.')}</p><p class="muted-copy">${esc(item.status)} / ${esc(date(item.createdAt))}</p><button class="action-button" data-resolve="${esc(item.id)}" type="button">Resolve report</button></article>`;
    return `<article class="moderation-item"><h3>${esc(item.action)}</h3><p class="muted-copy">${esc(date(item.createdAt))}</p><p class="mono">Actor: ${esc(item.actorId||'System')}<br>Project: ${esc(item.projectId||'-')}<br>Version: ${esc(item.version||'-')}<br>Hash: ${esc(item.hash||'-')}</p><pre>${esc(JSON.stringify(item.details||{},null,2))}</pre></article>`;
  }
  async function list(page=1){
    const revision=++state.revision;state.page=page;
    const params=new URLSearchParams({page:String(page)});
    $('moderationReportFilter').hidden=state.tab!=='reports';
    if(state.tab==='reports')params.set('status',$('moderationReportStatus').value);
    if(state.tab==='audit'&&$('moderationAction').value.trim())params.set('action',$('moderationAction').value.trim());
    const data=await api('/'+state.tab+'?'+params);if(revision!==state.revision)return;
    state.items=data.items;state.pages=data.pages;
    $('moderationItems').innerHTML=data.items.length?data.items.map(render).join(''):'<p class="notice">No records in this view.</p>';
    $('moderationCount').textContent=data.total+' records';$('moderationPage').textContent='Page '+page+' of '+Math.max(1,data.pages);
    $('moderationPrevious').disabled=page<=1;$('moderationNext').disabled=page>=data.pages;
    document.querySelectorAll('[data-mod-tab]').forEach(el=>el.setAttribute('aria-current',el.dataset.modTab===state.tab?'page':'false'));
  }
  async function busy(button,fn){button.disabled=true;message('');try{await fn();}catch(error){message(error.message,true);}finally{button.disabled=false;}}
  document.querySelectorAll('[data-mod-tab]').forEach(button=>button.addEventListener('click',()=>{state.tab=button.dataset.modTab;list().catch(error=>message(error.message,true));}));
  $('moderationReportStatus').addEventListener('change',()=>list().catch(error=>message(error.message,true)));
  $('moderationRefresh').addEventListener('click',()=>Promise.all([overview(),list()]).catch(error=>message(error.message,true)));
  $('moderationPrevious').addEventListener('click',()=>list(state.page-1).catch(error=>message(error.message,true)));
  $('moderationNext').addEventListener('click',()=>list(state.page+1).catch(error=>message(error.message,true)));
  $('moderationItems').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    busy(button,async()=>{
      if(button.dataset.decision){const note=button.closest('article').querySelector('[data-note]').value.trim();if(!note)throw Error('Add a decision note first.');await api('/submissions/'+button.dataset.id+'/decision','POST',{decision:button.dataset.decision,note});}
      else if(button.dataset.resolve)await api('/reports/'+button.dataset.resolve+'/resolve','POST',{note:'Reviewed by moderator.'});
      await Promise.all([overview(),list(state.page)]);message('Decision recorded.');
    });
  });
  $('quarantineForm').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{await api('/projects/'+$('quarantineProject').value.trim()+'/quarantine','POST',{expectedVersion:Number($('quarantineVersion').value),expectedHash:$('quarantineHash').value.trim(),note:$('quarantineNote').value.trim()});await Promise.all([overview(),list()]);message('Project quarantined.');});});
  $('moderationRoleForm').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{await api('/accounts/'+encodeURIComponent($('roleAccount').value.trim())+'/role','PUT',{role:$('roleValue').value});message('Moderator access updated.');});});
  $('moderationExport').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(state.items,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='audit-hub-'+state.tab+'-page-'+state.page+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  api('/me').then(async me=>{
    $('moderationRole').textContent=me.role;
    if(!['moderator','admin'].includes(me.role)){$('moderationDenied').hidden=false;return;}
    $('moderationAdmin').hidden=me.role!=='admin';$('moderationWorkspace').hidden=false;await Promise.all([overview(),list()]);
  }).catch(error=>{$('moderationDenied').hidden=false;message(error.message,true);});
  window.addEventListener('pagehide',()=>{$('moderationItems').replaceChildren();state.items=[];document.querySelectorAll('input').forEach(input=>input.value='');});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
})();
