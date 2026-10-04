'use strict';
// Original source and build logs stay inside the signed-in owner's workspace.
(() => {
  const $ = id => document.getElementById(id);
  const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const labels = {
    en: {
      activity:'Release activity', cancelJob:'Cancel this build', logs:'Dated processing log', prerequisite:'Save your Lua source in Script hosting first.', listingPipeline:'Publication rebuilds the saved private original using these options, then updates the catalogue after successful checks. Free access makes the delivered build downloadable by anyone. The previous release stays available while processing.', intro:'Upload a Lua/Luau file or paste your source. Obfuscation is your choice and starts switched off. Local checks run before a successful build replaces the previous version. Failed or held builds keep the active release available.', guide:'Read about protection and compatibility', sourceTitle:'Your private original', sourceEmpty:'No saved original yet.', readOriginal:'Read original', downloadOriginal:'Download original', editOriginal:'Edit original', uploadFile:'Upload file (optional)', fileHint:'Lua, Luau or text, encoded as UTF-8. Maximum 8 MiB (8,388,608 bytes). Your file is read without modification.', protection:'Release protection', obfuscate:'Obfuscate before publication', defaultOff:'Optional, switched off by default. Your original stays private and editable.', level:'Obfuscation level', standard:'Standard', strong:'Strong', limits:'Protection can increase file size and startup time. It cannot prevent reverse engineering or copying; test the delivered build in your executor.', saveBuild:'Publish script', history:'Build history', refresh:'Refresh', historyEmpty:'Your next uploads and publications will appear here.', historyCaption:'Private history for the selected project', created:'Created', file:'Original file', sizes:'Before / after', status:'Status', actions:'Actions', ownerOnly:'These originals and processing logs are visible only to your signed-in account.', originalTitle:'Private original', originalReadonly:'Readable source, shown without modification', close:'Close', standardHint:'Standard renames locals, compacts code and encodes strings with Prometheus. It keeps generic loops. Test the result; compatibility is not guaranteed.', strongHint:'Strong uses Prometheus virtualization and string protection, with a higher size and execution cost. Generic for loops (including pairs/ipairs) are rejected: choose Standard for those scripts. Method arguments that may have side effects are also refused. Unsupported syntax and builds exceeding resource limits fail without a silent fallback. AntiTamper and dedicated opaque predicates are not enabled.', standardBadge:'Obfuscated (Standard)', strongBadge:'Obfuscated (Strong)', legacy:'Legacy light obfuscation', plain:'Without obfuscation', queued:'Queued', processing:'Processing', review:'Awaiting review', succeeded:'Completed', failed:'Failed', cancelled:'Cancelled', by:'By', saved:'Saved', detail:'Details and log', progress:'Build progress', noOriginal:'This older build has no recoverable original. Upload your readable source to edit or republish it.', tooLarge:'The original must be no larger than 8 MiB (8,388,608 UTF-8 bytes).', invalidFile:'Choose a .lua, .luau or .txt file encoded as valid UTF-8.', invalidFilename:'Use a filename of up to 120 characters without folder separators or control characters.', invalidSource:'Provide readable Lua/Luau source without invalid Unicode or zero bytes.', selected:'Original ready to upload', editing:'Private original loaded for editing. Obfuscation is switched off; choose it explicitly for this new build.', uploadQueued:'Build queued. Your previous release stays available while processing.', publishQueued:'Public release queued. The current listing stays available until the new build succeeds.', complete:'Build saved successfully. Your loader URL stays the same.', publicComplete:'Public release updated after successful checks.', held:'Build held for moderator review. Your previous release remains available.', cancelConfirm:'Cancel this build? The active release will remain unchanged.', cancelledMessage:'Build cancelled. The active release was kept.', sourceFailed:'The original could not be loaded. Sign in again if your session expired.', refreshFailed:'Build history could not be refreshed.', active:'A build is already queued or processing. Wait or cancel it before starting another.', originalChanged:'Original source edited', download:'Download original', none:'No log entries yet.', historicalUnavailable:'Historical original no longer available', private:'Private source', sourceLabel:'Lua source', target:'Where should this script run?', game:'Roblox game link or Place ID'
    },
    fr: {
      activity:'Activité de publication', cancelJob:'Annuler ce traitement', logs:'Journal de traitement daté', prerequisite:'Enregistrez d’abord votre source Lua dans Hébergement du script.', listingPipeline:'La publication reconstruit l’original privé enregistré avec ces options, puis met à jour le catalogue après les vérifications réussies. L’accès libre rend le build livré téléchargeable par tous. La version précédente reste disponible pendant le traitement.', intro:'Importez un fichier Lua/Luau ou collez votre source. L’obfuscation est facultative et désactivée au départ. Les vérifications locales précèdent le remplacement de la version active. Un échec ou une mise en revue conserve la version disponible.', guide:'Comprendre la protection et la compatibilité', sourceTitle:'Votre original privé', sourceEmpty:'Aucun original enregistré pour le moment.', readOriginal:'Lire l’original', downloadOriginal:'Télécharger', editOriginal:'Modifier l’original', uploadFile:'Importer un fichier (facultatif)', fileHint:'Lua, Luau ou texte, encodé en UTF-8. Maximum 8 Mio (8 388 608 octets). Votre fichier est lu sans modification.', protection:'Protection de la version', obfuscate:'Obfusquer avant publication', defaultOff:'Facultatif, désactivé par défaut. Votre original reste privé et modifiable.', level:'Niveau d’obfuscation', standard:'Standard', strong:'Fort', limits:'La protection peut augmenter la taille et le temps de démarrage. Elle ne peut empêcher la rétro-ingénierie ou la copie : testez le build livré dans votre executor.', saveBuild:'Publier le script', history:'Historique des traitements', refresh:'Actualiser', historyEmpty:'Vos prochains imports et publications apparaîtront ici.', historyCaption:'Historique privé du projet sélectionné', created:'Création', file:'Fichier original', sizes:'Avant / après', status:'État', actions:'Actions', ownerOnly:'Ces originaux et journaux de traitement sont visibles uniquement dans votre compte connecté.', originalTitle:'Original privé', originalReadonly:'Source lisible, affichée sans modification', close:'Fermer', standardHint:'Le niveau Standard renomme les variables locales, compacte le code et encode les chaînes avec Prometheus. Il conserve les boucles génériques. Testez le résultat : sa compatibilité n’est pas garantie.', strongHint:'Le niveau Fort utilise la virtualisation et la protection des chaînes de Prometheus, avec un coût plus élevé en taille et en exécution. Les boucles for génériques (dont pairs/ipairs) sont refusées : choisissez Standard pour ces scripts. Les arguments de méthode pouvant avoir des effets sont aussi refusés. Une syntaxe incompatible ou un dépassement des limites échoue sans remplacement silencieux. AntiTamper et les prédicats opaques dédiés ne sont pas activés.', standardBadge:'Obfusqué (Standard)', strongBadge:'Obfusqué (Fort)', legacy:'Obfuscation légère ancienne', plain:'Sans obfuscation', queued:'En file d’attente', processing:'En cours', review:'En attente de revue', succeeded:'Terminé', failed:'Échec', cancelled:'Annulé', by:'Par', saved:'Enregistré', detail:'Détails et journal', progress:'Progression du traitement', noOriginal:'Cet ancien build n’a pas d’original récupérable. Importez votre source lisible pour le modifier ou le republier.', tooLarge:'L’original ne doit pas dépasser 8 Mio (8 388 608 octets en UTF-8).', invalidFile:'Choisissez un fichier .lua, .luau ou .txt encodé en UTF-8 valide.', invalidFilename:'Utilisez un nom de fichier de 120 caractères maximum, sans séparateur de dossier ni caractère de contrôle.', invalidSource:'Fournissez une source Lua/Luau lisible, sans Unicode invalide ni octets nuls.', selected:'Original prêt à importer', editing:'Original privé chargé pour modification. L’obfuscation est désactivée : choisissez-la explicitement pour ce nouveau traitement.', uploadQueued:'Traitement en file d’attente. Votre version précédente reste disponible pendant le traitement.', publishQueued:'Publication en file d’attente. La page actuelle reste disponible jusqu’au succès du nouveau build.', complete:'Build enregistré après vérification. L’URL du loader reste la même.', publicComplete:'Version publique mise à jour après les vérifications réussies.', held:'Build en attente de revue par un modérateur. Votre version précédente reste disponible.', cancelConfirm:'Annuler ce traitement ? La version active restera inchangée.', cancelledMessage:'Traitement annulé. La version active a été conservée.', sourceFailed:'L’original n’a pas pu être chargé. Reconnectez-vous si votre session a expiré.', refreshFailed:'L’historique des traitements n’a pas pu être actualisé.', active:'Un traitement est déjà en attente ou en cours. Patientez ou annulez-le avant d’en lancer un autre.', originalChanged:'Source originale modifiée', download:'Télécharger l’original', none:'Aucune entrée de journal pour le moment.', historicalUnavailable:'Original historique indisponible', private:'Source privée', sourceLabel:'Source Lua', target:'Où ce script doit-il fonctionner ?', game:'Lien du jeu Roblox ou Place ID'
    }
  };
  function preferredLanguage() {
    try { const stored = localStorage.getItem('audit-hub-language'); if (Object.hasOwn(labels,stored)) return stored; } catch {}
    return (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }
  const bytes = value => new TextEncoder().encode(value).length;
  function validSource(value) {
    // Lone UTF-16 surrogates would otherwise be silently replaced during encoding.
    return !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  }
  function safeFilename(value) { return String(value || 'script.lua').replace(/[\\/\x00-\x1f\x7f]/g,'_').slice(0,120) || 'script.lua'; }
  window.AuditHubScripts = { create({api,catalogApi,message,view,selectedPlaceId,onComplete}) {
    const state = {projectId:'',script:null,jobs:[],selectedJob:'',language:preferredLanguage(),username:'',view:'overview',timer:null,generation:0,filename:'script.lua',fileContent:null,pendingDraft:null,reading:false,submitting:false,notified:new Set()};
    const t = key => labels[state.language][key] || labels.en[key] || key;
    const busyJob = job => ['queued','processing'].includes(job.status);
    const active = () => state.jobs.find(busyJob);
    const formatDate = value => value ? new Date(value).toLocaleString(state.language,{dateStyle:'medium',timeStyle:'short'}) : '—';
    function size(value) { if (value == null) return '—'; if (value < 1024) return value+' B'; return (value / (value < 1048576 ? 1024 : 1048576)).toLocaleString(state.language,{maximumFractionDigits:2}) + (value < 1048576 ? ' KiB' : state.language==='fr'?' Mio':' MiB'); }
    function stop() { clearTimeout(state.timer); state.timer=null; state.generation++; }
    const content = () => state.fileContent ?? $('scriptContent').value;
    function sourceSize() { const count=bytes(content()); $('scriptSourceSize').textContent=size(count)+' / '+(state.language==='fr'?'8 Mio':'8 MiB'); $('scriptContent').setCustomValidity(count > MAX_SOURCE_BYTES ? t('tooLarge') : validSource(content()) ? '' : t('invalidSource')); }
    function options() { return {obfuscate:$('scriptObfuscate').checked,obfuscationLevel:$('scriptObfuscationLevel').value==='strong'?'strong':'standard'}; }
    function optionFields() { $('scriptObfuscationOptions').hidden=!$('scriptObfuscate').checked; $('scriptObfuscationLevel').disabled=!$('scriptObfuscate').checked || !!active() || state.submitting; $('scriptObfuscationHint').textContent=t($('scriptObfuscationLevel').value==='strong'?'strongHint':'standardHint'); }
    function syncActions() {
      const working=!!active() || state.submitting || state.reading;
      $('publishScriptBtn').disabled=working || !state.projectId;
      $('publishListingBtn').disabled=working || !state.script || state.script.originalAvailable===false;
      $('scriptObfuscate').disabled=working;
      $('scriptFile').disabled=working;
      optionFields();
    }
    function sourceMeta() {
      const script=state.script, available=!!script && script.originalAvailable!==false;
      ['viewScriptOriginal','downloadScriptOriginal','editScriptOriginal'].forEach(id=>$(id).hidden=!available);
      $('scriptSourceMeta').textContent=!script?t('sourceEmpty'):!available?t('noOriginal'):[safeFilename(script.filename),size(script.originalSizeBytes),t('saved')+' '+formatDate(script.updatedAt),t('by')+' '+state.username].filter(Boolean).join(' · ');
      $('scriptSourceMeta').removeAttribute('data-script-text');
      $('scriptProtectionBadge').hidden=!script;
      $('scriptProtectionBadge').textContent=script ? script.obfuscated?t(script.obfuscationLevel==='strong'?'strongBadge':script.obfuscationLevel==='standard'?'standardBadge':'legacy'):t('plain') : '';
      $('listingPrerequisite').hidden=!!script && available;
      if(script && !available) $('listingPrerequisite').textContent=t('noOriginal');
      else $('listingPrerequisite').textContent=t('prerequisite');
    }
    function render() {
      sourceMeta(); syncActions();
      const job=state.jobs.find(item=>item.id===state.selectedJob) || active() || state.jobs[0];
      $('scriptBuildActivity').hidden=!job || !['script','publichub'].includes(state.view);
      if(job) {
        $('scriptJobStatus').textContent=t(job.status);
        $('scriptJobStatus').className='status-pill '+(job.status==='failed'?'status-bad':job.status==='succeeded'?'status-good':'');
        $('scriptJobName').textContent=safeFilename(job.filename);
        $('scriptJobDetail').textContent=[t('by')+' '+state.username,formatDate(job.createdAt),job.obfuscate?t(job.obfuscationLevel==='strong'?'strong':'standard'):t('plain'),size(job.originalSizeBytes)+' → '+size(job.outputSizeBytes)].join(' · ');
        $('cancelScriptJob').hidden=!busyJob(job);
        $('cancelScriptJob').dataset.job=job.id;
        $('scriptJobProgressWrap').hidden=!busyJob(job);
        const progress=Number.isFinite(job.progress)?Math.min(100,Math.max(0,job.progress)):0;
        $('scriptJobProgress').value=progress; $('scriptJobProgress').setAttribute('aria-label',t('progress')); $('scriptJobPercent').textContent=progress+'%';
        $('scriptJobError').hidden=!job.error;
        $('scriptJobError').textContent=job.error ? [job.error.code,job.error.message].filter(Boolean).join(' · ') : '';
        $('scriptJobLogList').innerHTML=job.logs?.length ? job.logs.map(log=>'<li class="log-'+(log.level==='error'?'error':log.level==='warning'?'warning':'info')+'"><time datetime="'+escape(log.date)+'">'+escape(formatDate(log.date))+'</time><span>'+escape(log.message)+'</span></li>').join('') : '<li><span>'+escape(t('none'))+'</span></li>';
      }
      $('scriptJobsEmpty').hidden=state.jobs.length>0;
      $('scriptHistoryTable').hidden=!state.jobs.length;
      $('scriptJobsBody').innerHTML=state.jobs.map(item=>'<tr><td>'+escape(formatDate(item.createdAt))+'<span class="file-meta">'+escape(t('by')+' '+state.username)+'</span></td><td>'+escape(safeFilename(item.filename))+'<span class="file-meta">'+escape(item.kind==='publish'?(state.language==='fr'?'Publication publique':'Public release'):(state.language==='fr'?'Import de source':'Source upload'))+'</span></td><td>'+escape(item.obfuscate?t(item.obfuscationLevel==='strong'?'strong':'standard'):t('plain'))+'</td><td>'+escape(size(item.originalSizeBytes))+'<br>→ '+escape(size(item.outputSizeBytes))+'</td><td><span class="status-pill '+(item.status==='failed'?'status-bad':item.status==='succeeded'?'status-good':'')+'">'+escape(t(item.status))+'</span></td><td><div class="row-actions"><button type="button" class="action-button script-log-button" data-script-job="'+escape(item.id)+'">'+escape(t('detail'))+'</button>'+ (item.originalAvailable===false?'<span class="file-meta">'+escape(t('historicalUnavailable'))+'</span>':'<button type="button" class="action-button" data-job-source="'+escape(item.id)+'">'+escape(t('download'))+'</button>')+'</div></td></tr>').join('');
    }
    function translate(language) {
      if(!Object.hasOwn(labels,language)) return;
      state.language=language;
      document.querySelectorAll('[data-script-text]').forEach(element=>element.textContent=t(element.dataset.scriptText));
      $('scriptBuildControls').lang=language; $('scriptOriginalDialog').lang=language; $('scriptBuildActivity').lang=language;
      $('scriptFile').closest('label').querySelector('span').textContent=t('uploadFile');
      $('scriptContent').closest('label').querySelector('span').textContent=t('sourceLabel');
      $('scriptTargetMode').closest('label').querySelector('span').textContent=t('target');
      $('scriptPlaceId').closest('label').querySelector('span').textContent=t('game');
      $('scriptOriginalDialog').querySelector('[data-close-dialog]').setAttribute('aria-label',t('close'));
      $('scriptHistoryTable').setAttribute('aria-label',t('history'));
      sourceSize(); render();
    }
    async function updateJob(job) {
      const index=state.jobs.findIndex(item=>item.id===job.id);
      if(index<0) state.jobs.unshift(job); else state.jobs[index]=job;
      if(!state.jobs.some(item=>item.id===state.selectedJob)) state.selectedJob=job.id;
      render();
      const notification=job.id+':'+job.status;
      if(!busyJob(job) && !state.notified.has(notification)) {
        state.notified.add(notification);
        if(job.id===state.pendingDraft?.jobId && ['succeeded','failed','cancelled'].includes(job.status)) {
          // Keep a rejected/cancelled draft available for correction, and never
          // clear edits made while the accepted version was being processed.
          if(job.status==='succeeded' && content()===state.pendingDraft.source && state.filename===state.pendingDraft.filename) {
            state.fileContent=null; $('scriptContent').value=''; $('scriptFile').value=''; sourceSize();
          }
          state.pendingDraft=null;
        }
        if(job.status==='succeeded') { message(t(job.kind==='publish'?'publicComplete':'complete')); await onComplete(state.projectId,job); }
        else if(job.status==='review') message(t('held'));
        else if(job.status==='failed') message(job.error?.message || t('failed'),true);
      }
    }
    function schedule(delay=1000) {
      clearTimeout(state.timer);
      const job=active(), projectId=state.projectId, generation=state.generation;
      if(!job || document.hidden || !['script','publichub'].includes(state.view)) return;
      state.timer=setTimeout(async()=>{
        try {
          const data=await api('/projects/'+projectId+'/jobs/'+job.id);
          if(generation!==state.generation || projectId!==state.projectId) return;
          await updateJob(data.job);
          if(generation===state.generation) schedule(2000);
        } catch(error) { if(generation===state.generation) message(error.message || t('refreshFailed'),true); }
      },delay);
    }
    async function loadJobs() {
      const projectId=state.projectId, generation=state.generation;
      if(!projectId) return;
      const data=await api('/projects/'+projectId+'/jobs?limit=10');
      if(projectId!==state.projectId || generation!==state.generation) return;
      const previous=new Map(state.jobs.map(job=>[job.id,job.status]));
      state.jobs=data.jobs || []; render();
      const completed=state.jobs.find(job=>['queued','processing','review'].includes(previous.get(job.id)) && !busyJob(job) && previous.get(job.id)!==job.status);
      if(completed) await updateJob(completed);
      if(projectId===state.projectId && generation===state.generation) schedule();
    }
    async function start(result,kind) {
      if(!result.job || !result.jobId) throw Error('The server did not provide a build job.');
      state.selectedJob=result.job.id;
      const old=state.jobs.findIndex(item=>item.id===result.job.id);
      if(old<0) state.jobs.unshift(result.job); else state.jobs[old]=result.job;
      message(t(kind==='publish'?'publishQueued':'uploadQueued')); render(); schedule();
    }
    async function fetchOriginal(jobId) {
      if(!state.projectId) throw Error(t('sourceFailed'));
      const projectId=state.projectId, endpoint='/api/platform/projects/'+projectId+(jobId?'/jobs/'+encodeURIComponent(jobId):'')+'/source';
      const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store'});
      if(!response.ok) { const error=await response.json().catch(()=>null); throw Error(response.status===404?t('noOriginal'):error?.error || t('sourceFailed')); }
      const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await response.arrayBuffer());
      if(projectId!==state.projectId) throw Error(t('sourceFailed'));
      const job=state.jobs.find(item=>item.id===jobId);
      return {content,filename:safeFilename(job?.filename || state.script?.filename),size:bytes(content)};
    }
    async function originalAction(action,jobId) {
      if(state.reading) return;
      state.reading=true; syncActions();
      try {
        const original=await fetchOriginal(jobId);
        if(action==='read') {
          $('scriptOriginalContent').value=original.content;
          $('scriptOriginalInfo').textContent=original.filename+' · '+size(original.size)+' · '+t('private');
          $('scriptOriginalDialog').showModal(); $('scriptOriginalContent').focus();
        } else if(action==='edit') {
          state.filename=original.filename; state.fileContent=original.content; $('scriptContent').value=original.content; $('scriptFile').value=''; $('scriptObfuscate').checked=false; $('scriptObfuscationLevel').value='standard'; sourceSize(); view('script'); message(t('editing')); $('scriptContent').focus();
        } else {
          const url=URL.createObjectURL(new Blob([original.content],{type:'text/plain;charset=utf-8'})), link=document.createElement('a');
          link.href=url; link.download=original.filename; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
        }
      } catch(error) { message(error.message,true); }
      finally { state.reading=false; syncActions(); }
    }
    $('scriptObfuscate').addEventListener('change',optionFields);
    $('scriptObfuscationLevel').addEventListener('change',optionFields);
    $('scriptContent').addEventListener('input',()=>{state.fileContent=null;sourceSize();});
    $('scriptFile').addEventListener('change',async()=>{
      const file=$('scriptFile').files[0]; if(!file) return;
      if(file.size>MAX_SOURCE_BYTES) { $('scriptFile').value=''; message(t('tooLarge'),true); return; }
      if(!/\.(lua|luau|txt)$/i.test(file.name)) { $('scriptFile').value=''; message(t('invalidFile'),true); return; }
      if(file.name.length>120 || /[\\/\x00-\x1f\x7f]/.test(file.name)) { $('scriptFile').value=''; message(t('invalidFilename'),true); return; }
      state.reading=true; syncActions(); const generation=state.generation;
      try {
        const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());
        if(!validSource(content)) throw Error(t('invalidFile'));
        if(generation!==state.generation) return;
        state.fileContent=content; $('scriptContent').value=content; state.filename=safeFilename(file.name); sourceSize(); message(t('selected')+' · '+state.filename+' · '+size(file.size));
      } catch { $('scriptFile').value=''; message(t('invalidFile'),true); }
      finally { state.reading=false; syncActions(); }
    });
    $('scriptForm').addEventListener('submit',async event=>{
      event.preventDefault(); if(state.submitting || state.reading || active()) return;
      const source=content(); sourceSize();
      if(!source.trim() || !$('scriptForm').reportValidity()) return;
      state.submitting=true; syncActions(); message('');
      try {
        const targetMode=$('scriptTargetMode').value;
        const result=await api('/projects/'+state.projectId+'/script','PUT',{content:source,filename:state.filename,...options(),targetMode,...(targetMode==='single'?{placeId:selectedPlaceId()}: {})});
        state.pendingDraft={jobId:result.jobId,source,filename:state.filename}; await start(result,'upload');
      } catch(error) { message(error.message,true); }
      finally { state.submitting=false; syncActions(); }
    });
    $('refreshScriptJobs').addEventListener('click',()=>loadJobs().catch(error=>message(error.message,true)));
    $('scriptJobsBody').addEventListener('click',event=>{
      const details=event.target.closest('[data-script-job]'), download=event.target.closest('[data-job-source]');
      if(details) { state.selectedJob=details.dataset.scriptJob; render(); $('scriptJobLogs').open=true; $('scriptBuildActivity').scrollIntoView({behavior:'instant',block:'start'}); }
      if(download) originalAction('download',download.dataset.jobSource);
    });
    $('cancelScriptJob').addEventListener('click',async()=>{
      const id=$('cancelScriptJob').dataset.job; if(!$('cancelScriptJob').hidden && confirm(t('cancelConfirm'))) {
        $('cancelScriptJob').disabled=true;
        try { const result=await api('/projects/'+state.projectId+'/jobs/'+id+'/cancel','POST',{}); if(result.job) await updateJob(result.job); else await loadJobs(); message(t('cancelledMessage')); }
        catch(error) { message(error.message,true); }
        finally { $('cancelScriptJob').disabled=false; }
      }
    });
    $('viewScriptOriginal').addEventListener('click',()=>originalAction('read'));
    $('downloadScriptOriginal').addEventListener('click',()=>originalAction('download'));
    $('editScriptOriginal').addEventListener('click',()=>originalAction('edit'));
    $('scriptOriginalDialog').addEventListener('close',()=>{$('scriptOriginalContent').value=''; $('scriptOriginalInfo').textContent='';});
    document.addEventListener('audit-hub:language',event=>translate(event.detail?.language));
    document.addEventListener('visibilitychange',()=>{ if(document.hidden) stop(); else if(['script','publichub'].includes(state.view)) loadJobs().catch(error=>message(error.message,true)); });
    window.addEventListener('pagehide',()=>{stop();state.fileContent=null;state.pendingDraft=null;$('scriptOriginalContent').value='';});
    translate(state.language);
    return {
      syncActions,
      async publish(body) {
        if(active()) throw Error(t('active'));
        state.submitting=true; syncActions();
        try { await start(await catalogApi('/projects/'+state.projectId,'PUT',{...body,...options()}),'publish'); }
        finally { state.submitting=false; syncActions(); }
      },
      async setProject(detail,username) {
        const projectId=detail?.project?.id || '';
        if(projectId!==state.projectId) { stop(); state.jobs=[]; state.selectedJob=''; state.pendingDraft=null; state.filename='script.lua'; $('scriptObfuscate').checked=false; $('scriptObfuscationLevel').value='standard'; }
        state.projectId=projectId; state.script=detail?.script || null; state.username=username || '';
        render(); if(projectId) await loadJobs();
      },
      setView(name) {
        const previous=state.view; state.view=name;
        const slot=$(name==='publichub'?'listingBuildControlsSlot':'scriptBuildControlsSlot');
        if($('scriptBuildControls').parentElement!==slot) slot.append($('scriptBuildControls'));
        if(!['script','publichub'].includes(name)) stop();
        else if(!['script','publichub'].includes(previous)) loadJobs().catch(error=>message(error.message,true));
        else schedule();
        render();
      },
      clear() { stop(); state.fileContent=null; state.pendingDraft=null; $('scriptOriginalContent').value=''; if($('scriptOriginalDialog').open) $('scriptOriginalDialog').close(); $('scriptContent').value=''; $('scriptFile').value=''; state.filename='script.lua'; sourceSize(); }
    };
  } };
})();
