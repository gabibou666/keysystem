'use strict';
(() => {
  const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
  const project = params.get('project'), session = params.get('session'), failed = params.get('checkpoint') === 'failed';
  const providerNames = {lootlabs:'LootLabs',workink:'Work.ink',linkvertise:'Linkvertise',linkunlocker:'LinkUnlocker'};
  let providerName = 'provider';
  let timer, polling = false;
  const message = (text,error=false) => { $('claimMessage').textContent=text; $('claimMessage').className='message-bar'+(error?' error':''); };
  async function request(path,method='GET') { const res=await fetch('/api/platform'+path,{method,headers:method==='POST'?{'Content-Type':'application/json'}:{},body:method==='POST'?'{}':undefined}); const data=await res.json(); if(!res.ok||!data.success) throw Error(data.error || 'Request failed'); return data; }
  async function poll() {
    if(polling || document.hidden) return; polling=true;
    try { const d=await request('/checkpoints/'+encodeURIComponent(session)+'/status');
      if(d.status==='completed') { clearInterval(timer); $('claimResult').hidden=false; $('claimKey').value=d.key; message('Your key is ready. Save it before leaving this page.'); }
      else if(failed) {message(`${providerName} could not verify this return. Start a new checkpoint or contact the developer.`,true); $('startCheckpointBtn').hidden=false;}
      else message(`Waiting for ${providerName} confirmation: ${d.completed}/${d.required} task(s). Return here after completion.`);
    } catch(e) { clearInterval(timer); message(e.message,true); $('startCheckpointBtn').hidden=false; }
    finally { polling=false; }
  }
  $('startCheckpointBtn').addEventListener('click',async()=>{ $('startCheckpointBtn').disabled=true; message('Creating your checkpoint…'); try { const d=await request('/checkpoints/'+encodeURIComponent(project)+'/start','POST'); location.assign(d.url); } catch(e) { message(e.message,true); $('startCheckpointBtn').disabled=false; } });
  $('copyClaimKeyBtn').addEventListener('click',async()=>{try {await navigator.clipboard.writeText($('claimKey').value);message('Key copied.');}catch{message('Select your key and copy it manually.',true);} });
  if(!project) {message('This link does not include a project. Ask the developer for the complete key page URL.',true);return;}
  request('/public/projects/'+encodeURIComponent(project)).then(d=>{ $('claimTitle').textContent=d.project.name; $('claimDescription').textContent=d.project.description || `Complete ${d.project.checkpointCount} task(s) for a ${d.project.durationHours}-hour key.`;
    providerName=providerNames[d.project.checkpointProvider] || 'provider';
    if(session) {poll();timer=setInterval(poll,5000);} else if(d.project.available) { message(`Complete the ${providerName} checkpoint, then return here to receive your key.`); $('startCheckpointBtn').hidden=false; } else message('This developer has not configured checkpoints yet. Contact them for a key.',true);
  }).catch(e=>message(e.message,true));
  document.addEventListener('visibilitychange',()=>{if(session&&!document.hidden&&$('claimResult').hidden)poll();});
})();
