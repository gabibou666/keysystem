'use strict';
function link(value, discord=false){
  if(value===undefined||value==='')return '';
  if(typeof value!=='string'||value.length>500)throw Error('Invalid public link');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)throw Error('Use a clean HTTPS link');
  if(discord){
    const valid=(url.hostname==='discord.gg'&&/^\/[a-zA-Z0-9-]{2,100}\/?$/.test(url.pathname)) || (url.hostname==='discord.com'&&/^\/invite\/[a-zA-Z0-9-]{2,100}\/?$/.test(url.pathname));
    if(!valid)throw Error('Use a Discord community invite');
  }else if(!/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(url.hostname)||/\.(local|internal|localhost)$/.test(url.hostname))throw Error('Use a public website');
  return url.href;
}
function fields(body){
  const avatarTheme=body.avatarTheme===undefined?'orbit':body.avatarTheme;
  if(!['orbit','circuit','prism'].includes(avatarTheme))throw Error('Choose a profile theme');
  return {discordUrl:link(body.discordUrl,true),websiteUrl:link(body.websiteUrl),avatarTheme};
}
module.exports={fields,link};
