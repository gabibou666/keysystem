'use strict';
// Diagnostics contain origins/routes and error classes, never submitted text,
// URL credentials, query strings, fragments or SQL/provider error messages.
const errorNames=new Set(['Error','TypeError','RangeError','SyntaxError','ReferenceError','URIError','EvalError','AggregateError','AbortError','TimeoutError']);
const nodeCodes=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EAI_AGAIN','EPIPE','ENOENT','EACCES']);
const routeSegments=new Set(['api','auth','platform','catalog','discord','admin','robux','scripts','hubs','healthz','ping','signup','login','reset-password','verify-email','projects','me','licenses','script','token','checkpoints','start','return','postback','status','v1','v2','check','loader','options','logout','forgot','resend','verify','reset','google','callback','getkey','stats','public','hub','revoke','restore','reset-device','source','keepalive','csp-report','dashboard','docs','claim','index']);
function errorSummary(error){
  const name=errorNames.has(error?.name)?error.name:'Error';
  const code=typeof error?.code==='string'&&(/^[0-9A-Z]{5}$/.test(error.code)||nodeCodes.has(error.code))?error.code:'';
  return name+(code?' ('+code+')':'');
}
function diagnosticUrl(value){
  if(typeof value!=='string'||value.length>8192)return '(redacted)';
  if(['inline','eval','self','none','about:blank'].includes(value))return value;
  try{
    const url=new URL(value,'https://local.invalid');
    if(!['http:','https:'].includes(url.protocol))return '(redacted)';
    const route=url.pathname.split('/').map(segment=>!segment||routeSegments.has(segment)?segment:':id').join('/');
    return (url.origin==='https://local.invalid'?'':url.origin)+route;
  }catch{return '(redacted)';}
}
function diagnosticDirective(value){
  if(typeof value!=='string')return '(unknown)';
  const name=value.split(/\s/)[0];
  return /^(?:default|script|style|img|connect|font|media|frame|child|worker|object|manifest)-src(?:-elem|-attr)?$|^(?:frame-ancestors|base-uri|form-action|sandbox|upgrade-insecure-requests|block-all-mixed-content)$/.test(name)?name:'(unknown)';
}
module.exports={errorSummary,diagnosticUrl,diagnosticDirective};
