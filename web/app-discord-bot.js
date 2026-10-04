'use strict';
(()=>{
  const $=id=>document.getElementById(id),state={guilds:[],revision:0,selected:''};
  const fields={botVerificationChannel:'verification_channel_id',botVerificationType:'verification_type',botVerifiedRole:'verified_role_id',botUnverifiedRole:'unverified_role_id',botWelcomeChannel:'welcome_channel_id',botModLogChannel:'mod_log_channel_id',botTicketCategory:'ticket_category_id',botTicketChannel:'ticket_channel_id',botTicketLogChannel:'ticket_log_channel_id',botSupportRole:'support_role_id',botWelcomeMessage:'welcome_message',botAutoMod:'automod_enabled',botAiAutoMod:'ai_automod_enabled',botAntiInvite:'anti_invite_enabled',botAntiSpam:'anti_spam_enabled'};
  function message(text,error=false){$('botMessage').hidden=!text;$('botMessage').textContent=text;$('botMessage').className='message-bar'+(error?' error':'');}
  async function api(path,method='GET',body){const response=await fetch('/api/bot'+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json().catch(()=>({error:'Unexpected server response.'}));if(!response.ok)throw Object.assign(Error(data.error||'Request refused.'),{status:response.status});return data;}
  function options(element,items,selected){element.replaceChildren(new Option('Not configured',''));for(const item of items)element.add(new Option(item.name,item.id));if(selected&&!items.some(item=>item.id===selected))element.add(new Option('Unavailable / '+selected,selected));element.value=selected||'';}
  async function loadGuild(){
    const revision=++state.revision;state.selected='';$('botSettingsPanel').hidden=true;message('');
    const guild=state.guilds.find(g=>g.id===$('botGuild').value);if(!guild)return;
    try{
      const data=await api('/guilds/'+guild.id+'/settings');if(revision!==state.revision)return;
      for(const [element,key] of Object.entries(fields)){const input=$(element),value=data.settings[key];if(input.type==='checkbox')input.checked=!!value;else if(key.endsWith('_id'))options(input,key==='ticket_category_id'?guild.categories:key.endsWith('role_id')?guild.roles:guild.channels,value);else input.value=value||'';}
      state.selected=guild.id;$('botGuildName').textContent=guild.name;$('botSettingsPanel').hidden=false;
    }catch(error){if(revision===state.revision)message(error.message,true);}
  }
  async function refresh(){
    ++state.revision;state.selected='';$('botSettingsPanel').hidden=true;$('botGuild').disabled=true;$('botRefresh').disabled=true;message('');
    try{
      const data=await api('/status');state.guilds=data.guilds||[];$('botWorkspace').hidden=false;$('botRefresh').hidden=false;$('botSetup').hidden=data.configured;
      $('botConnection').textContent=!data.configured?'Not configured':data.online?'Connected':'Bot offline';$('botName').textContent=data.name||'Not connected';$('botLatency').textContent=data.latency===null||data.latency===undefined?'-':data.latency+' ms';$('botGuildCount').textContent=state.guilds.length;
      $('botGuild').replaceChildren(new Option('Choose a server',''));for(const guild of state.guilds)$('botGuild').add(new Option(guild.name,guild.id));$('botGuild').disabled=!data.online||!state.guilds.length;
    }catch(error){$('botConnection').textContent='Unavailable';if([401,403].includes(error.status)){$('botDenied').hidden=false;$('botWorkspace').hidden=true;$('botRefresh').hidden=true;}else{$('botWorkspace').hidden=false;$('botRefresh').hidden=false;message(error.message,true);}}
    finally{$('botRefresh').disabled=false;}
  }
  $('botGuild').addEventListener('change',loadGuild);$('botRefresh').addEventListener('click',refresh);
  $('botSettingsForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!state.selected)return;const guild=state.selected,body={};for(const [element,key] of Object.entries(fields)){const input=$(element);body[key]=input.type==='checkbox'?input.checked:key.endsWith('_id')?input.value||null:input.value;}
    $('botSave').disabled=true;$('botGuild').disabled=true;message('');
    try{await api('/guilds/'+guild+'/settings','PUT',body);message('Server settings saved.');}catch(error){message(error.message,true);}finally{$('botSave').disabled=false;$('botGuild').disabled=false;}
  });
  window.addEventListener('pagehide',()=>{++state.revision;state.guilds=[];state.selected='';$('botSettingsPanel').hidden=true;for(const key of Object.keys(fields)){$(key).type==='checkbox'?$(key).checked=false:$(key).value='';}});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});refresh();
})();
