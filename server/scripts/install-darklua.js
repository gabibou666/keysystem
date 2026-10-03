'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const VERSION='0.19.0';
const assets={
  'win32-x64':['darklua-windows-x86_64.zip','e099313a768a0628bce861123dff6959f0c7dc49b5c353d9523a144c1fa2124e'],
  'linux-x64':['darklua-linux-x86_64.zip','353b7a7772cec97994fd991fb3c143b39654ff154bd6dabfd7abf9fbe9ab7ea8'],
  'linux-arm64':['darklua-linux-aarch64.zip','b308a5724b4781e89fbac42bd5906342d9ea0374961d64b8b5f0681bba2cdcac'],
  'darwin-x64':['darklua-macos-x86_64.zip','bb364f898e83e8204d56b6d6d9e6edd8c391300dd4a82cd06e4d36d1f0a66b1a'],
  'darwin-arm64':['darklua-macos-aarch64.zip','b97be3d771dd82c11134af96fb8ed48f4163740eacc1f32eeda735074f51e59b'],
};
const folder=path.resolve(__dirname,'../tools/darklua');
const executable=path.join(folder,process.platform==='win32'?'darklua.exe':'darklua');
function extractBinary(zip){
  // Only extract the expected executable; never use archive paths as targets.
  let end=-1;for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--)if(zip.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw Error('Invalid release ZIP');
  let at=zip.readUInt32LE(end+16);const count=zip.readUInt16LE(end+10);
  for(let i=0;i<count;i++){
    if(zip.readUInt32LE(at)!==0x02014b50)throw Error('Invalid ZIP directory');
    const method=zip.readUInt16LE(at+10),size=zip.readUInt32LE(at+20),uncompressed=zip.readUInt32LE(at+24),nameLength=zip.readUInt16LE(at+28),extraLength=zip.readUInt16LE(at+30),commentLength=zip.readUInt16LE(at+32),local=zip.readUInt32LE(at+42);
    const name=zip.subarray(at+46,at+46+nameLength).toString('utf8');
    if(name.split('/').at(-1)===path.basename(executable)){
      if(uncompressed>100*1024*1024||zip.readUInt32LE(local)!==0x04034b50)throw Error('Invalid executable entry');
      const start=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28),bytes=zip.subarray(start,start+size);
      const output=method===0?bytes:method===8?zlib.inflateRawSync(bytes,{maxOutputLength:100*1024*1024}):null;
      if(!output||output.length!==uncompressed)throw Error('Invalid executable compression');return output;
    }
    at+=46+nameLength+extraLength+commentLength;
  }
  throw Error('Executable not found in official archive');
}
async function install(){
  try{
    const metadata=JSON.parse(await fs.readFile(path.join(folder,'installed.json'),'utf8'));
    const binary=await fs.readFile(executable);
    if(metadata.version===VERSION&&metadata.sha256===crypto.createHash('sha256').update(binary).digest('hex')){console.log('darklua '+VERSION+' already installed.');return;}
  }catch{}
  const asset=assets[process.platform+'-'+process.arch];if(!asset)throw Error('Unsupported platform for pinned darklua');
  const url='https://github.com/seaofvoices/darklua/releases/download/v'+VERSION+'/'+asset[0];
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Could not download official darklua release');
  const maxArchive=50*1024*1024;
  if(Number(response.headers.get('content-length'))>maxArchive){await response.body.cancel();throw Error('Release archive exceeds size limit');}
  const chunks=[];let received=0;const reader=response.body.getReader();
  try{while(true){const {done,value}=await reader.read();if(done)break;received+=value.length;if(received>maxArchive){await reader.cancel();throw Error('Release archive exceeds size limit');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  const zip=Buffer.concat(chunks,received);
  if(zip.length>50*1024*1024||crypto.createHash('sha256').update(zip).digest('hex')!==asset[1])throw Error('darklua archive checksum mismatch');
  const binary=extractBinary(zip);await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(executable,binary,{mode:0o755});await fs.chmod(executable,0o755);
  await fs.writeFile(path.join(folder,'installed.json'),JSON.stringify({version:VERSION,sha256:crypto.createHash('sha256').update(binary).digest('hex')})+'\n');
  console.log('Installed official darklua '+VERSION+' with verified SHA-256.');
}
if(require.main===module)install().catch(()=>{console.error('Pinned darklua installation failed; script builds remain unavailable.');process.exitCode=1;});
module.exports={VERSION,executable,install};
