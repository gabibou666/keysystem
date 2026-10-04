'use strict';
const {settleResponse}=require('./tests/script-jobs');
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
async function run(){
 const f=await startFixture();let count=0;
 const check=(value,label)=>{assert.ok(value,label);count++;console.log('OK '+label);};
 async function req(path,method='GET',body,cookie=f.cookies[0]){
  const response=await fetch(f.base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:f.base}:{})},body:body?JSON.stringify(body):undefined});
  return settleResponse(f,response,cookie);
 }
 try{
  const profile={name:'Public creator',slug:'public-creator',description:'My public biography',published:true,discordUrl:'https://discord.gg/creator-community',websiteUrl:'https://example.com/',avatarTheme:'prism'};
  check((await req('/api/catalog/me','PUT',profile)).status===200,'Owner saves a real profile');
  const id=(await req('/api/platform/projects','POST',{name:'Private source project'})).data.project.id;
  await req('/api/platform/projects/'+id+'/script','PUT',{content:'return "mobile-release"'});
  const listing={title:'Mobile release',description:'Works with touch controls',game:'Universal',accessMode:'licensed',mobileSupport:'yes',published:true};
  check((await req('/api/catalog/projects/'+id,'PUT',listing)).status===200,'Mobile support is published as a developer declaration');
  const detail=(await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing;
  check(detail.mobileSupport==='yes'&&detail.hasKeySystem===true&&detail.discordUrl===profile.discordUrl,'Public script shows mobile, key system and developer community');
  const hub=(await req('/api/catalog/hubs/public-creator','GET',undefined,'')).data.hub;
  check(hub.name===profile.name&&hub.description===profile.description&&hub.websiteUrl===profile.websiteUrl&&hub.avatarTheme==='prism'&&hub.joinedAt,'Public profile contains only chosen identity and links');
  check(!JSON.stringify(hub).includes('email'),'Public profile does not expose account email');
  await req('/api/catalog/projects/'+id,'PUT',{...listing,accessMode:'free',mobileSupport:'no'});
  const free=(await req('/api/catalog/scripts/'+id,'GET',undefined,'')).data.listing;
  check(free.hasKeySystem===false&&free.mobileSupport==='no','Free access cannot falsely advertise a required key system');
  check((await req('/api/catalog/projects/'+id,'PUT',{...listing,mobileSupport:'maybe'})).status===400,'Unknown compatibility enum is rejected');
  check((await req('/api/catalog/projects/'+id,'PUT',listing,f.cookies[1])).status===404,'Another developer cannot change compatibility metadata');
  for(const value of ['javascript:alert(1)','https://discord.gg.evil.example/invite','https://discord.gg/community?secret=foo','https://name:password@discord.gg/community','http://discord.gg/community','https://discord.com/channels/example','https://discord.gg:444/community']){
   check((await req('/api/catalog/me','PUT',{...profile,discordUrl:value})).status===400,'Unsafe or incorrect Discord URL rejected');
  }
  check((await req('/api/catalog/me','PUT',{...profile,websiteUrl:'https://127.0.0.1/'})).status===400,'Private IP website link rejected');
  check((await req('/api/catalog/me','PUT',{...profile,avatarTheme:'../../secret'})).status===400,'Avatar cannot reference arbitrary files or URLs');
  await req('/api/catalog/me','PUT',{...profile,published:false});
  check((await req('/api/catalog/hubs/public-creator','GET',undefined,'')).status===404&&(await req('/api/catalog/scripts/'+id,'GET',undefined,'')).status===404,'Hiding profile hides its community links and scripts');
  check((await req('/api/catalog/me')).data.hub.discordUrl===profile.discordUrl,'Owner can edit retained private profile');
  const events=(await f.pool.query("SELECT action FROM developer_moderation_audit WHERE action IN ('profile.updated','listing.published')")).rows;
  check(events.some(x=>x.action==='profile.updated')&&events.some(x=>x.action==='listing.published'),'Profile and publication actions are audited');
  console.log('Public profiles: '+count+' checks passed.');
 }finally{await f.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
