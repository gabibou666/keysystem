'use strict';
const fs=require('fs/promises'),path=require('path'),os=require('os'),{spawn}=require('child_process'),crypto=require('crypto');
const {executable,VERSION}=require('../../scripts/install-darklua');
let active=0;
function failure(code,message){const e=new Error(message);e.code=code;return e;}
function target(body={}){
  const mode=body.targetMode===undefined?'universal':body.targetMode;
  if(!['universal','single'].includes(mode))throw failure('SCRIPT_INVALID','Choose universal access or one Roblox place.');
  if(mode==='single'&&(!Number.isSafeInteger(body.placeId)||body.placeId<1))throw failure('SCRIPT_INVALID','Enter a positive Roblox Place ID.');
  if(mode==='universal'&&body.placeId!==undefined&&body.placeId!==null)throw failure('SCRIPT_INVALID','Universal scripts must not specify a Place ID.');
  return {targetMode:mode,placeId:mode==='single'?body.placeId:null};
}
function command(args,deadline){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});let bytes=0,finished=false,stopError,killTimer;
    const stop=error=>{if(stopError)return;stopError=error;child.kill();killTimer=setTimeout(()=>child.kill('SIGKILL'),250);};
    const timer=setTimeout(()=>stop(failure('SCRIPT_TIMEOUT','Script processing timed out. Try a smaller script.')),Math.max(1,deadline-Date.now()));
    function end(error){if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);error?reject(error):resolve();}
    const consume=chunk=>{bytes+=chunk.length;if(bytes>16384)stop(failure('SCRIPT_INVALID','Script processing failed. Check your Lua/Luau syntax.'));};
    child.stdout.on('data',consume);child.stderr.on('data',consume);
    child.on('error',()=>end(failure('SCRIPT_UNAVAILABLE','Script validation is currently unavailable.')));
    child.on('close',code=>end(stopError||(code===0?null:failure('SCRIPT_INVALID','Invalid Lua/Luau syntax. Check your script and try again.'))));
  });
}
async function processCode(content,obfuscate){
  if(typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>1024*1024)throw failure('SCRIPT_INVALID','Provide a Lua/Luau script smaller than 1 MB.');
  if(active>=2)throw failure('SCRIPT_BUSY','Script processing is busy. Try again shortly.');active++;
  let directory;
  const deadline=Date.now()+15000;
  try{
    await fs.access(executable).catch(()=>{throw failure('SCRIPT_UNAVAILABLE','Script validation is currently unavailable.');});
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'ah-build-'));await fs.chmod(directory,0o700);
    const input=path.join(directory,'input.luau'),output=path.join(directory,'output.luau'),verified=path.join(directory,'verified.luau'),config=path.join(directory,'config.json');
    await fs.writeFile(input,content,{mode:0o600});
    await fs.writeFile(config,JSON.stringify({rules:obfuscate?['remove_types',{rule:'rename_variables',globals:['$default','$roblox'],include_functions:true,detect_globals:true}]:[],generator:'dense'}),{mode:0o600});
    await command(['process',input,output,'--config',config],deadline);
    // Parsing the generated result prevents returning a malformed build.
    await command(['minify',output,verified],deadline);
    const result=await fs.readFile(verified,'utf8');
    if(!result.trim()||Buffer.byteLength(result)>2*1024*1024)throw failure('SCRIPT_INVALID','Generated script exceeds the supported size.');return result;
  }finally{
    try{
      if(directory){
        const resolved=path.resolve(directory),tempRoot=path.resolve(os.tmpdir());
        if(path.dirname(resolved)===tempRoot&&path.basename(resolved).startsWith('ah-build-'))await fs.rm(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{throw failure('SCRIPT_UNAVAILABLE','Script processing cleanup failed. Please try again.');});
      }
    }finally{active--;}
  }
}
async function build(content,options={}){
  const choice=target(options);
  const guard=choice.targetMode==='single'?`assert(game.PlaceId == ${choice.placeId}, "This script is for another Roblox place.")\n`:'';
  const code=await processCode(guard+content,true);
  return {code,...choice,validated:true,obfuscated:true,builderVersion:'darklua-'+VERSION,buildHash:crypto.createHash('sha256').update(code).digest('hex')};
}
async function validate(content){await processCode(content,false);return true;}
module.exports={build,validate,target};
