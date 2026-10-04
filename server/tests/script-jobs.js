'use strict';
const assert = require('node:assert/strict');
// Existing integration scenarios await the COMPLETE upload/publication flow.
// The dedicated jobs tests assert the real 202 response and every intermediate
// state separately; this helper never substitutes a builder or database mock.
async function waitJob(f, projectId, id, cookie, timeout = 110000) {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) {
  const response = await fetch(f.base+'/api/platform/projects/'+projectId+'/jobs/'+id, { headers: cookie ? {Cookie:cookie} : {} });
  const data = await response.json();
  assert.equal(response.status,200,JSON.stringify(data));
  if (!['queued','processing'].includes(data.job.status)) return data.job;
  await new Promise(resolve => setTimeout(resolve,30));
 }
 throw new Error('Timed out waiting for durable script job '+id);
}
async function settleQueued(f, result, cookie) {
 if (result.status!==202 || !result.data?.queued || !result.data?.job) return result;
 const job=await waitJob(f,result.data.job.projectId,result.data.jobId,cookie);
 let status,data;
 if(job.status==='succeeded') {
  status=200;data={success:true,...job.result,jobId:job.id,job};
  if(job.kind==='publish') {
   const response=await fetch(f.base+'/api/catalog/me',{headers:{Cookie:cookie}});
   const owner=await response.json();assert.equal(response.status,200);
   data.listing=owner.listings.find(item=>item.projectId===job.projectId);
  }
 } else if(job.status==='review') {status=202;data={success:true,...job.result,jobId:job.id,job};}
 else {
  status={SCRIPT_INVALID:400,SCRIPT_UNSUPPORTED_STRONG:400,SCRIPT_TIMEOUT:422,SCRIPT_RESOURCE_LIMIT:422,SECURITY_BLOCKED:422,RELEASE_CHANGED:409,PROJECT_UNAVAILABLE:403,SCRIPT_CANCELLED:409}[job.error?.code]||503;
  data={success:false,error:job.error?.message||'Job cancelled.',code:job.error?.code,...job.result,jobId:job.id,job};
 }
 return {...result,status,data,text:JSON.stringify(data),queuedStatus:202};
}
async function settleResponse(f,response,cookie) {
 const data=response.headers.get('content-type')?.includes('json')?await response.json():await response.text();
 return settleQueued(f,{status:response.status,headers:response.headers,data,text:typeof data==='string'?data:JSON.stringify(data)},cookie);
}
module.exports={waitJob,settleQueued,settleResponse};
