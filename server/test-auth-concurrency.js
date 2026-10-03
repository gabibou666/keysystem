'use strict';
const assert=require('node:assert/strict');
const {startFixture}=require('./tests/platform-fixture');
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function run() {
  const f=await startFixture();
  const auth=require('./src/services/developer-auth');
  const nativeConnect=f.pool.connect.bind(f.pool),nativeFetch=global.fetch,realMatches=auth.passwordMatches;
  const locks=new Map();let waiting,holdLock;
  // pg-mem ignores FOR UPDATE. Supply an exclusive account row-lock adapter
  // while still running actual routes and database queries. No production DB.
  f.pool.connect=async()=>{
    const backing=await nativeConnect();const query=backing.query.bind(backing),release=backing.release.bind(backing);const client={};let held;
    const unlock=()=>{if(held){locks.get(held).resolve();locks.delete(held);held=null;}};
    client.query=async(sql,args)=>{
      if(/developer_accounts.*FOR UPDATE/.test(sql)) {
        const key='account'; // fixture exercises one account; email and ID are the same row
        while(locks.has(key)){if(waiting)waiting.resolve();await locks.get(key).promise;}
        locks.set(key,defer());held=key;
        if(holdLock && args[0]===holdLock.id) {holdLock.entered.resolve();await holdLock.resume.promise;}
      }
      const result=await query(sql,args);
      if(sql==='COMMIT'||sql==='ROLLBACK')unlock();
      return result;
    };
    client.release=()=>{unlock();release();};return client;
  };
  const mailbox=[];
  global.fetch=async(url,options)=>{if(String(url)==='https://api.resend.com/emails'){mailbox.push(JSON.parse(options.body));return new Response('{"id":"test"}',{status:200});}return nativeFetch(url,options);};
  async function post(route,body){const r=await fetch(f.base+'/api/auth/'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:f.base},body:JSON.stringify(body)});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  try {
    process.env.RESEND_API_KEY='test-only';process.env.AUTH_EMAIL_FROM='test@example.com';
    const id='concurrency-account';const oldPassword='old-strong-password-123';
    await f.pool.query('INSERT INTO developer_accounts(discord_id,username,email,password_hash,email_verified) VALUES($1,$2,$3,$4,true)',[id,'Concurrency developer','concurrency@example.com',await auth.passwordHash(oldPassword)]);
    await Promise.all(Array.from({length:3},()=>auth.sendToken(id,'concurrency@example.com','reset')));
    assert.equal(mailbox.length,1,'Concurrent sends produce one email');
    assert.equal((await f.pool.query('SELECT * FROM developer_email_tokens WHERE account_id=$1',[id])).rows.length,1,'Concurrent sends reserve one token');
    const token=new URL(mailbox[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    const checked=defer(),resume=defer();
    auth.passwordMatches=async(...args)=>{const result=await realMatches(...args);checked.resolve();await resume.promise;return result;};
    const loginPromise=post('login',{email:'concurrency@example.com',password:oldPassword});await checked.promise;
    waiting=defer();const resetPromise=post('reset',{token,password:'new-strong-password-456'});
    let timer;
    try {await Promise.race([waiting.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Reset did not wait for the account lock')),5000);})]);} finally {clearTimeout(timer);}
    resume.resolve();const [login,reset]=await Promise.all([loginPromise,resetPromise]);
    assert.equal(login.status,200);assert.equal(reset.status,200);
    assert.equal((await fetch(f.base+'/api/platform/projects',{headers:{Cookie:login.cookie}})).status,401,'Reset invalidates the session created by an in-flight old-password login');
    auth.passwordMatches=realMatches;
    assert.equal((await post('login',{email:'concurrency@example.com',password:oldPassword})).status,401,'Old password fails once reset has committed');
    assert.equal((await post('login',{email:'concurrency@example.com',password:'new-strong-password-456'})).status,200,'New password succeeds after reset');
    await auth.sendToken(id,'concurrency@example.com','reset');
    const nextToken=new URL(mailbox.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    holdLock={id,entered:defer(),resume:defer()};
    const resetFirst=post('reset',{token:nextToken,password:'third-strong-password-789'});await holdLock.entered.promise;
    waiting=defer();const staleLogin=post('login',{email:'concurrency@example.com',password:'new-strong-password-456'});
    try {await Promise.race([waiting.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Login did not wait for reset')),5000);})]);} finally {clearTimeout(timer);}
    holdLock.resume.resolve();const [resetResult,staleResult]=await Promise.all([resetFirst,staleLogin]);holdLock=null;
    assert.equal(resetResult.status,200);assert.equal(staleResult.status,401,'A login queued behind reset checks the current hash');
    console.log('Auth concurrency: concurrent emails deduplicated, both login/reset orderings preserve session revocation.');
  } finally {auth.passwordMatches=realMatches;f.pool.connect=nativeConnect;global.fetch=nativeFetch;await f.close();}
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
