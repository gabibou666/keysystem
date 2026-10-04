'use strict';
const assert=require('node:assert/strict');
process.env.AES_KEY='1'.repeat(64);delete process.env.SCHEDULERS;
const dbPath=require.resolve('./src/db');let queries=0;
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{query:async()=>{queries++;throw Error('PRIVATE_DATABASE_SECRET');}}};
const native={timeout:global.setTimeout,interval:global.setInterval,clearTimeout:global.clearTimeout,clearInterval:global.clearInterval,error:console.error};
const timers=[],intervals=[],logs=[];
global.setTimeout=(fn,delay)=>{const timer={fn,delay,cleared:false,unref(){return this;}};timers.push(timer);return timer;};
global.setInterval=(fn,delay)=>{const timer={fn,delay,cleared:false,unref(){return this;}};intervals.push(timer);return timer;};
global.clearTimeout=timer=>{if(timer)timer.cleared=true;};global.clearInterval=global.clearTimeout;
console.error=value=>logs.push(value);
async function run(){
 const service=require('./src/services/script-revalidation');let stop;
 try{
  stop=service.startScheduler();assert.equal(service.startScheduler(),stop);assert.equal(timers.length,1);assert.equal(timers[0].delay,15000);
  for(const delay of [30000,60000,90000]){await timers.at(-1).fn();assert.equal(timers.at(-1).delay,delay);}
  await timers.at(-1).fn();assert.equal(queries,4);assert.equal(timers.length,4,'Initial attempt plus three retries only');
  assert(!logs.join('').includes('PRIVATE_DATABASE_SECRET'));
  await intervals[0].fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(timers.length,5,'Next daily sweep has a fresh retry budget');
  stop();assert(timers.at(-1).cleared&&intervals[0].cleared);
  const count=queries;await timers.at(-1).fn();assert.equal(queries,count,'Stopped scheduler does not resume work');
  process.env.SCHEDULERS='off';service.startScheduler();assert.equal(timers.length,5,'Disabled scheduler creates no timers');
  console.log('Script revalidation scheduler: startup/daily, three delayed retries, safe logs, idempotence, stop and disabled mode passed.');
 }finally{stop?.();Object.assign(global,{setTimeout:native.timeout,setInterval:native.interval,clearTimeout:native.clearTimeout,clearInterval:native.clearInterval});console.error=native.error;}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
