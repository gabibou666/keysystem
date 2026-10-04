'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const childProcess = require('node:child_process');
const builder = require('./src/services/script-builder');
const prometheus = require('./scripts/install-prometheus'), luau = require('./scripts/install-luau');
const tools = require('./scripts/script-tool-install'), compatibility = require('./scripts/prometheus-compat'), luaRuntime = require('./scripts/install-lua-runtime');
async function run() {
  let checks = 0; const check = (condition, message) => { assert.ok(condition, message); checks++; };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-engine-test-'));
  const runtimes = [luau.interpreter, prometheus.executable];
  const samples = [
    { name: 'variables/strings', code: '-- private source comment\nlocal descriptivePrivateName="private literal α 😀"; return descriptivePrivateName', expected: '"private literal α 😀"' },
    { name: 'numeric for/continue/compound/types', code: 'local count: number=0;for index=1,5 do if index==2 then continue end count+=index end return count', expected: '13' },
    { name: 'methods and scope', code: 'local object={value=1};function object:add(n)self.value=self.value+n;return self.value end;local a=object:add(2);return a+object:add(3)', expected: '9' },
    { name: 'getgenv and loadstring external globals', code: 'local env=getgenv();env.engineFixture=41;return loadstring("return 1")()+getgenv().engineFixture', expected: '42' },
    { name: 'closure and varargs', code: 'local function capture(n)return function(...)local a,b=...;return n+a+b end end;return capture(4)(2,3)', expected: '9' },
    { name: 'compound index side effects', code: 'local calls=0;local values={7};local function index()calls+=1;return 1 end;values[index()]+=5;return values[1]+calls', expected: '13' },
    { name: 'interpolated strings and floor division', code: 'local x=7;local text=`value {x}`;return text .. ":" .. tostring(-7//2)', expected: '"value 7:-4"' },
    { name: 'zero bytes in string', code: 'local data="a\\000\\255z";return #data+string.byte(data,3)', expected: '259' },
    { name: 'method simple local and table arguments', code: 'local value=3;local object={};function object:method(a,b,values)return a+b+values[1]end;return object:method(value,-2,{5})', expected: '6' },
    { name: 'method indexed lookup effects without argument effects', code: 'local calls=0;local object=setmetatable({}, {__index=function()calls=calls+1;return function()return calls end end});local a=object:method();local b=object:method();return a+b', expected: '3' },
  ];
  async function execute(code, expected, runtime, name) {
    const file = path.join(directory, name + '.lua');
    const prelude = 'local fixtureEnv={}\ngetgenv=function()return fixtureEnv end\ngame={PlaceId=123}\n';
    const script = prelude + 'local function entry(...)\n' + code + '\nend\nlocal actual=entry(4)\nassert(actual==' + expected + ', "fixture result differed")\nprint("fixture passed")\n';
    await fs.writeFile(file, script);
    const result = childProcess.spawnSync(runtime, [file], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin' }, shell: false });
    assert.equal(result.status, 0, name + ': ' + result.stderr); check(result.stdout.includes('fixture passed'), name + ' preserves controlled fixture behavior');
  }
  try {
    const original = samples[0].code;
    const plain = await builder.build(original);
    check(plain.validated && !plain.obfuscated && plain.obfuscationLevel === null && plain.code === original, 'Obfuscation is disabled by default and preserves source exactly');
    check(plain.originalSizeBytes === Buffer.byteLength(original) && plain.outputSizeBytes === Buffer.byteLength(plain.code) && plain.buildDurationMs >= 0 && plain.metrics.luauCompilerVersion === luau.VERSION, 'Build metrics describe input, output, processing time and pinned compiler');
    check(plain.buildHash === crypto.createHash('sha256').update(plain.code).digest('hex'), 'Build fingerprint describes the actual served output');
    for (const level of ['standard', 'strong']) {
      for (const sample of samples) {
        const result = await builder.build(sample.code, { obfuscate: true, obfuscationLevel: level });
        check(result.validated && result.obfuscated && result.obfuscationLevel === level && result.builderVersion.includes('prometheus-' + prometheus.VERSION), level + ' uses the pinned upstream engine');
        for (const runtime of runtimes) await execute(result.code, sample.expected, runtime, level + '-' + sample.name.replace(/[^a-z]/gi, '-'));
        if (sample === samples[0]) check(!result.code.includes('descriptivePrivateName') && !result.code.includes('private literal') && !result.code.includes('private source comment'), level + ' obscures local names, strings and comments');
      }
    }
    // The upstream scheduling failure was seed-sensitive. Include its known
    // failing seed plus other controlled seeds in the permanent regression.
    const nativeRandomInt = crypto.randomInt;
    try {
      for (const seed of [1, 4, 19, 73]) {
        crypto.randomInt = () => seed;
        for (const sample of samples.filter(item => item.name.includes('method'))) {
          const result = await builder.build(sample.code, { obfuscate: true, obfuscationLevel: 'strong' });
          for (const runtime of runtimes) await execute(result.code, sample.expected, runtime, 'seed-' + seed + '-' + sample.name.replace(/[^a-z]/gi, '-'));
        }
      }
    } finally { crypto.randomInt = nativeRandomInt; }
    const ambiguousMethods = [
      { name: 'method argument changes method', code: 'local object={};function object:method(x)return 1 end;local function change()object.method=function()return 2 end;return 0 end;return object:method(change())', lua: '1', luau: '2' },
      { name: 'statement argument changes method', code: 'local result=0;local object={};function object:method(x)result=1 end;local function change()object.method=function()result=2 end;return 0 end;object:method(change());return result', lua: '1', luau: '2' },
      { name: 'multi return argument changes method', code: 'local object={};function object:method(x)return 1,2,3 end;local function change()object.method=function()return 10,10,10 end;return 0 end;local a,b,c=object:method(change());return a+b+c', lua: '6', luau: '30' },
      { name: 'method lookup and argument effects', code: 'local events="";local object=setmetatable({}, {__index=function(_,key)events=events.."i";return function(_,value)return events..tostring(value)end end});local function argument()events=events.."a";return 7 end;return object:method(argument())', lua: '"ia7"', luau: '"ai7"' },
    ];
    for (const sample of ambiguousMethods) {
      const result = await builder.build(sample.code, { obfuscate: true, obfuscationLevel: 'standard' });
      for (const runtime of runtimes) await execute(result.code, runtime === luau.interpreter ? sample.luau : sample.lua, runtime, sample.name.replace(/ /g, '-'));
      await assert.rejects(builder.build(sample.code, { obfuscate: true, obfuscationLevel: 'strong' }), error => error.code === 'SCRIPT_UNSUPPORTED_STRONG' && /Standard/.test(error.message));
      check(true, 'Strong refuses ambiguous Lua/Luau method argument evaluation: ' + sample.name);
    }
    const guard = await builder.build('return game.PlaceId', { targetMode: 'single', placeId: 123, obfuscate: true });
    await execute(guard.code, '123', luau.interpreter, 'single-place-success');
    const guardFile = path.join(directory, 'wrong-place.lua'); await fs.writeFile(guardFile, 'game={PlaceId=456}\n' + guard.code);
    check(childProcess.spawnSync(luau.interpreter, [guardFile], { encoding: 'utf8', timeout: 3000, env: { PATH: '/usr/bin:/bin' } }).status !== 0, 'The place guard survives obfuscation and denies another place');
    const unsupported = [
      { name: 'generalized table iterator', code: 'local sum=0;for k,v in {5,7} do sum+=v end return sum', expected: '12' },
      { name: 'three iterator returns', code: 'local function iterate(_,key)if key==nil then return 1,2,3 end end;local sum=0;for a,b,c in iterate do sum=a+b+c end return sum', expected: '6' },
      { name: 'false iterator key', code: 'local used=false;local function iterate()if not used then used=true;return false,9 end end;local sum=0;for key,value in iterate do sum=value end return sum', expected: '9' },
    ];
    for (const sample of unsupported) {
      const result = await builder.build(sample.code, { obfuscate: true, obfuscationLevel: 'standard' });
      await execute(result.code, sample.expected, luau.interpreter, sample.name.replace(/ /g, '-'));
      await assert.rejects(builder.build(sample.code, { obfuscate: true, obfuscationLevel: 'strong' }), error => error.code === 'SCRIPT_UNSUPPORTED_STRONG' && /Standard/.test(error.message));
      check(true, 'Strong fails explicitly for ' + sample.name + ' instead of returning a changed script');
    }
    for (const content of ['local x = ( PRIVATE_INPUT', 'break', 'continue']) {
      await assert.rejects(builder.build(content), error => error.code === 'SCRIPT_INVALID' && !error.message.includes('PRIVATE_INPUT'));
      check(true, 'Official compiler rejects invalid syntax/loop semantics with generic errors');
    }
    for (const options of [{ obfuscate: 'true' }, { obfuscationLevel: 'custom' }, { targetMode: 'single', placeId: 0 }]) {
      await assert.rejects(builder.build('return 1', options), { code: 'SCRIPT_INVALID' }); check(true, 'Invalid processing options are rejected');
    }
    const boundary = '--' + 'x'.repeat(builder.MAX_INPUT_BYTES - 12) + '\nreturn 1\n';
    assert.equal(Buffer.byteLength(boundary), builder.MAX_INPUT_BYTES);
    const large = await builder.build(boundary);
    check(large.originalSizeBytes === builder.MAX_INPUT_BYTES && large.code === boundary, 'A valid 8 MiB script is accepted in None mode');
    await assert.rejects(builder.build(boundary + 'x'), { code: 'SCRIPT_INVALID' }); check(true, 'The 8 MiB limit is enforced in bytes');
    check((await builder.build('while true do end', { obfuscate: true, obfuscationLevel: 'strong' })).validated, 'Processing never executes an infinite-loop uploaded program');
    const concurrent = await Promise.allSettled([builder.build('return 1'), builder.build('return 2')]);
    check(concurrent[0].status === 'fulfilled' && concurrent[1].reason?.code === 'SCRIPT_BUSY', 'One build at a time bounds aggregate worker memory');
    await assert.rejects(builder.build(boundary, { timeoutMs: 1 }), { code: 'SCRIPT_TIMEOUT' }); check(true, 'A shared deadline rejects processing without a raw-source fallback');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(builder.build('return 1', { signal: controller.signal }), { code: 'SCRIPT_CANCELLED' }); check(true, 'Cancellation stops processing cleanly');
    check((await builder.build('return 4')).validated, 'Processing capacity is released after timeout and cancellation');
    const modulePath = require.resolve('./src/services/script-builder'), savedModule = require.cache[modulePath];
    const nativeSpawn = childProcess.spawn, directories = new Set();
    try {
      childProcess.spawn = (executable, args, options) => { if (path.basename(options.cwd || '').startsWith('ah-build-')) directories.add(options.cwd); check(!options.env?.DATABASE_URL && !options.env?.HMAC_SECRET && !options.env?.AES_KEY, 'Tool subprocesses receive no application secrets'); return nativeSpawn(executable, args, options); };
      delete require.cache[modulePath]; const tracked = require('./src/services/script-builder');
      await tracked.build('return 1'); await assert.rejects(tracked.build('break'), { code: 'SCRIPT_INVALID' });
      const exists = await Promise.all([...directories].map(dir => fs.access(dir).then(() => true, () => false)));
      check(exists.every(value => !value), 'Temporary source and generated files are removed after success and errors');
    } finally { childProcess.spawn = nativeSpawn; require.cache[modulePath] = savedModule; }
    const { EventEmitter } = require('node:events');
    for (const waitForWatch of [false, true]) {
      try {
        childProcess.spawn = (executable, args, options) => {
          const outputIndex = args.indexOf('--out');
          if (outputIndex < 0 || !args.includes(prometheus.cli)) return nativeSpawn(executable, args, options);
          const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          let closeTimer, closed = false;
          const close = () => { if (closed) return; closed = true; clearTimeout(closeTimer); child.emit('close', 0); };
          child.kill = () => { setImmediate(close); return true; };
          setImmediate(async () => {
            try {
              const handle = await fs.open(args[outputIndex + 1], 'w');
              try { await handle.truncate(builder.MAX_OUTPUT_BYTES + 1); } finally { await handle.close(); }
              closeTimer = setTimeout(close, waitForWatch ? 1000 : 1);
            } catch (error) { child.emit('error', error); }
          });
          return child;
        };
        delete require.cache[modulePath]; const bounded = require('./src/services/script-builder');
        await assert.rejects(bounded.build('return 1', { obfuscate: true }), error => error.code === 'SCRIPT_RESOURCE_LIMIT' && /output size/i.test(error.message));
        check(true, 'Oversized generated output gets a size-limit error '+(waitForWatch ? 'during processing' : 'after subprocess exit'));
      } finally { childProcess.spawn = nativeSpawn; require.cache[modulePath] = savedModule; }
    }
    for (const file of ['PROMETHEUS-LICENSE.txt', 'LUAU-LICENSE.txt', 'LUA-LICENSE.txt']) check((await fs.readFile(path.join(__dirname, 'licenses', file), 'utf8')).includes('Permission'), 'Distributed licence is retained: ' + file);
    const metadata = JSON.parse(await fs.readFile(path.join(prometheus.folder, 'installed.json'), 'utf8'));
    check(metadata.compatibilityVersion === prometheus.COMPATIBILITY_VERSION && plain.builderVersion.includes('luau-'), 'Audited compatibility version is present in installation metadata');
    check(await tools.installed(prometheus.folder, prometheus.VERSION, prometheus.ASSETS[process.platform+'-'+process.arch][1], ['LICENSE','runtime/LICENSE.txt','AUDIT-HUB-COMPATIBILITY.txt']), 'Installed upstream sources, patched files, runtime and licences all match retained checksums');
    assert.throws(() => compatibility.patchFiles(new Map(compatibility.PATCHES.map(patch => [patch.file, Buffer.from('unexpected upstream source')])))); check(true, 'Compatibility patch refuses unexpected upstream source');
    assert.throws(() => luaRuntime.sourceFiles(Buffer.from('unverified Lua source archive'))); check(true, 'Native Lua compilation accepts only the pinned official source hash');
    const cache = path.join(directory, 'cache'); await fs.mkdir(cache);
    await fs.writeFile(path.join(cache, 'installed.json'), JSON.stringify({version:'test',archiveSha256:'expected',files:{LICENSE:tools.sha256('license')}}));
    check(!await tools.installed(cache,'test','expected',['LICENSE']), 'Cached installs without a retained licence are invalid');
    await fs.writeFile(path.join(cache, 'LICENSE'), 'license');
    check(await tools.installed(cache,'test','expected',['LICENSE']), 'A complete cached install is accepted after checksum verification');
    await fs.writeFile(path.join(cache, 'LICENSE'), 'changed');
    check(!await tools.installed(cache,'test','expected',['LICENSE']), 'A corrupted cached licence is rejected');
    console.log('Obfuscation engine: ' + checks + ' checks passed using pinned upstream transforms and official Luau compilation. Only finite repository fixtures were executed in local Lua/Luau test runtimes.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
