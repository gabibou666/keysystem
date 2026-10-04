'use strict';
const fs = require('fs/promises'), path = require('path'), os = require('os'), { spawn } = require('child_process'), crypto = require('crypto');
const darklua = require('../../scripts/install-darklua');
const prometheus = require('../../scripts/install-prometheus');
const luau = require('../../scripts/install-luau');
const MAX_INPUT_BYTES = 8 * 1024 * 1024, MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_BUILD_MS = 90000, MEMORY_KB = (process.platform === 'linux' ? 256 : 512) * 1024;
let active = 0;
const failure = (code, message) => Object.assign(new Error(message), { code });
function target(body = {}) {
  const mode = body.targetMode === undefined ? 'universal' : body.targetMode;
  if (!['universal', 'single'].includes(mode)) throw failure('SCRIPT_INVALID', 'Choose universal access or one Roblox place.');
  if (mode === 'single' && (!Number.isSafeInteger(body.placeId) || body.placeId < 1)) throw failure('SCRIPT_INVALID', 'Enter a positive Roblox Place ID.');
  if (mode === 'universal' && body.placeId !== undefined && body.placeId !== null) throw failure('SCRIPT_INVALID', 'Universal scripts must not specify a Place ID.');
  return { targetMode: mode, placeId: mode === 'single' ? body.placeId : null };
}
function obfuscation(body = {}) {
  const enabled = body.obfuscate === undefined ? false : body.obfuscate;
  if (typeof enabled !== 'boolean') throw failure('SCRIPT_INVALID', 'Choose whether to obfuscate the script.');
  const level = body.obfuscationLevel === undefined ? 'standard' : body.obfuscationLevel;
  if (!['standard', 'strong'].includes(level)) throw failure('SCRIPT_INVALID', 'Choose Standard or Strong obfuscation.');
  return { obfuscate: enabled, obfuscationLevel: enabled ? level : null };
}
const childEnvironment = () => ({ PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin:/usr/sbin:/sbin', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), LANG: 'C', LC_ALL: 'C' });
async function command(executable, args, context) {
  if (context.signal?.aborted) throw failure('SCRIPT_CANCELLED', 'Script processing was cancelled.');
  if (Date.now() >= context.deadline) throw failure('SCRIPT_TIMEOUT', 'Script processing timed out. Try Standard mode or a smaller script.');
  let actual = executable, actualArgs = args;
  // Render/Linux uses a hard address-space and CPU limit. Other platforms
  // additionally monitor RSS; all subprocesses share the same total deadline.
  if (process.platform === 'linux') {
    const limiter = '/usr/bin/prlimit';
    try { await fs.access(limiter); actual = limiter; actualArgs = ['--as=' + MEMORY_KB * 1024, '--cpu=90', '--', executable, ...args]; }
    catch { throw failure('SCRIPT_UNAVAILABLE', 'The script worker memory limiter is unavailable.'); }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(actual, actualArgs, { cwd: context.directory, env: childEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let bytes = 0, finished = false, stopError, killTimer, checking = false, memoryProbe, resourceFailure = false;
    const stop = error => { if (finished || stopError) return; stopError = error; child.kill(); killTimer = setTimeout(() => child.kill('SIGKILL'), 250); };
    const abort = () => stop(failure('SCRIPT_CANCELLED', 'Script processing was cancelled.'));
    const timer = setTimeout(() => stop(failure('SCRIPT_TIMEOUT', 'Script processing timed out. Try Standard mode or a smaller script.')), Math.max(1, context.deadline - Date.now()));
    const watch = setInterval(async () => {
      if (finished || checking) return; checking = true;
      try {
        if (context.output && (await fs.stat(context.output).catch(() => null))?.size > MAX_OUTPUT_BYTES) stop(failure('SCRIPT_RESOURCE_LIMIT', 'Generated script exceeds the supported output size. Try Standard mode.'));
        if (process.platform !== 'linux' && process.platform !== 'win32' && child.pid && !finished) {
          const probe = memoryProbe = spawn('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { env: childEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], shell: false });
          let rss = ''; const probeTimer = setTimeout(() => probe.kill('SIGKILL'), 500);
          probe.stdout.on('data', chunk => { if (rss.length < 64) rss += chunk.toString(); });
          await new Promise(done => { probe.once('error', done); probe.once('close', done); }); clearTimeout(probeTimer); memoryProbe = null;
          if (Number(rss.trim()) > MEMORY_KB) stop(failure('SCRIPT_RESOURCE_LIMIT', 'Script processing exceeded the memory limit. Try Standard mode or a smaller script.'));
        }
      } finally { checking = false; }
    }, 250);
    function end(error) {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer); clearInterval(watch); memoryProbe?.kill('SIGKILL'); context.signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    }
    const consume = chunk => { resourceFailure ||= /out of memory|not enough memory|failed to allocate|memory allocation|bad_alloc|cannot allocate memory/i.test(chunk.toString()); bytes += chunk.length; if (bytes > 65536) stop(failure('SCRIPT_INVALID', 'Script processing failed. Check your Lua/Luau syntax.')); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', () => end(failure('SCRIPT_UNAVAILABLE', 'Script processing is currently unavailable.')));
    child.once('close', (code, signal) => end(stopError || (code === 0 ? null : context.unsupportedExit === code ? failure('SCRIPT_UNSUPPORTED_STRONG', 'Strong obfuscation cannot preserve this syntax in this engine version. Choose Standard mode.') : resourceFailure || ['SIGXCPU','SIGKILL','SIGABRT','SIGSEGV'].includes(signal) ? failure('SCRIPT_RESOURCE_LIMIT', 'Script processing exceeded its resource limit. Try Standard mode or a smaller script.') : failure('SCRIPT_INVALID', 'The script could not be compiled for Lua/Luau. Check the syntax or choose another obfuscation level.'))));
    context.signal?.addEventListener('abort', abort, { once: true }); if (context.signal?.aborted) abort();
  });
}
const NORMALIZE_RULES = ['remove_types', 'remove_attribute', 'remove_continue', 'remove_compound_assignment', 'remove_if_expression', 'remove_interpolated_string', 'remove_floor_division', 'convert_luau_number', 'make_assignment_local'];
function prometheusConfig(level) {
  // This is trusted integration configuration for upstream AST transforms,
  // never an obfuscator implemented here and never user-supplied Lua config.
  const strings = '{Name="ConstantArray",Settings={Treshold=1,StringsOnly=true,Shuffle=true,Rotate=true,LocalWrapperTreshold=0,Encoding="base64"}}';
  const split = '{Name="SplitStrings",Settings={Threshold=1,MinLength=1024,MaxLength=2048,ConcatenationType="table"}}';
  const steps = level === 'strong' ? [split, '{Name="EncryptStrings",Settings={}}', '{Name="Vmify",Settings={}}', strings, '{Name="NumbersToExpressions",Settings={Threshold=0.75,InternalThreshold=0.15,NumberRepresentationMutaton=false}}', '{Name="WrapInFunction",Settings={}}'] : [split, strings];
  // Positive seed avoids upstream's OpenSSL subprocess and preserves random
  // build variation without leaking application environment credentials.
  return 'return {LuaVersion="Lua51",VarNamePrefix="",NameGenerator="MangledShuffled",PrettyPrint=false,Seed=' + crypto.randomInt(1, 2147483647) + ',Steps={' + steps.join(',') + '}}';
}
async function run(content, options, validateOnly) {
  const originalSizeBytes = typeof content === 'string' ? Buffer.byteLength(content) : 0;
  if (typeof content !== 'string' || !content.trim() || originalSizeBytes > (validateOnly ? MAX_OUTPUT_BYTES : MAX_INPUT_BYTES)) throw failure('SCRIPT_INVALID', 'Provide a non-empty Lua/Luau script up to 8 MiB.');
  const choice = target(options), selection = obfuscation(options);
  if (active >= 1) throw failure('SCRIPT_BUSY', 'Script processing is busy. Try again shortly.'); active++;
  let directory;
  const start = Date.now(), duration = Number.isFinite(options.timeoutMs) ? Math.min(MAX_BUILD_MS, Math.max(1, options.timeoutMs)) : MAX_BUILD_MS;
  const context = { deadline: start + duration, signal: options.signal };
  try {
    await Promise.all([fs.access(darklua.executable), fs.access(luau.executable), ...(selection.obfuscate && !validateOnly ? [fs.access(prometheus.executable), fs.access(prometheus.cli)] : [])]).catch(() => { throw failure('SCRIPT_UNAVAILABLE', 'Script processing is currently unavailable.'); });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-build-')); await fs.chmod(directory, 0o700); context.directory = directory;
    const input = path.join(directory, 'input.luau'), parsed = path.join(directory, 'parsed.luau'), normalized = path.join(directory, 'normalized.lua'), output = path.join(directory, 'obfuscated.lua'), verified = path.join(directory, 'verified.luau'), config = path.join(directory, 'darklua.json'), obfuscatorConfig = path.join(directory, 'prometheus.lua');
    const guard = !validateOnly && choice.targetMode === 'single' ? `assert(game.PlaceId == ${choice.placeId}, "This script is for another Roblox place.")\n` : '';
    const source = guard + content; await fs.writeFile(input, source, { mode: 0o600 });
    // Compiler checks language semantics and register limits but never executes
    // input. Roblox globals are allowed; this is not strict type checking.
    await command(luau.executable, ['--null', '-O0', '-g0', input], context);
    context.output = parsed; await command(darklua.executable, ['minify', input, parsed], context);
    let code = source;
    if (selection.obfuscate && !validateOnly) {
      await fs.writeFile(config, JSON.stringify({ rules: NORMALIZE_RULES, generator: 'dense' }), { mode: 0o600 });
      context.output = normalized; await command(darklua.executable, ['process', input, normalized, '--config', config], context);
      if(selection.obfuscationLevel === 'strong') await command(prometheus.executable, [path.resolve(__dirname, '../../scripts/check-prometheus-compat.lua'), prometheus.folder, normalized], {...context,unsupportedExit:42});
      await fs.writeFile(obfuscatorConfig, prometheusConfig(selection.obfuscationLevel), { mode: 0o600 });
      context.output = output; await command(prometheus.executable, [prometheus.cli, '--config', obfuscatorConfig, '--out', output, '--nocolors', normalized], context);
      if ((await fs.stat(output)).size > MAX_OUTPUT_BYTES) throw failure('SCRIPT_RESOURCE_LIMIT', 'Generated script exceeds the supported output size. Try Standard mode.');
      context.output = verified; await command(darklua.executable, ['minify', output, verified], context);
      await command(luau.executable, ['--null', '-O0', '-g0', verified], context);
      if ((await fs.stat(verified)).size > MAX_OUTPUT_BYTES) throw failure('SCRIPT_RESOURCE_LIMIT', 'Generated script exceeds the supported output size. Try Standard mode.');
      code = await fs.readFile(verified, 'utf8');
    }
    if (!code.trim()) throw failure('SCRIPT_INVALID', 'Generated script is empty.');
    if (Buffer.byteLength(code) > MAX_OUTPUT_BYTES) throw failure('SCRIPT_RESOURCE_LIMIT', 'Generated script exceeds the supported output size.');
    const metrics = { originalSizeBytes, outputSizeBytes: Buffer.byteLength(code), buildDurationMs: Date.now() - start, obfuscate: !validateOnly && selection.obfuscate, obfuscationLevel: !validateOnly ? selection.obfuscationLevel : null, luauCompilerVersion: luau.VERSION };
    return { code, ...choice, validated: true, obfuscated: metrics.obfuscate, obfuscationLevel: metrics.obfuscationLevel, builderVersion: selection.obfuscate && !validateOnly ? 'darklua-' + darklua.VERSION + '+prometheus-' + prometheus.VERSION + '-' + prometheus.COMPATIBILITY_VERSION + '+luau-' + luau.VERSION : 'darklua-' + darklua.VERSION + '+luau-' + luau.VERSION, buildHash: crypto.createHash('sha256').update(code).digest('hex'), ...metrics, metrics };
  } finally {
    try {
      if (directory && path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('ah-build-')) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => { throw failure('SCRIPT_UNAVAILABLE', 'Script processing cleanup failed. Please try again.'); });
    } finally { active--; }
  }
}
async function build(content, options = {}) { return run(content, options, false); }
async function validate(content, options = {}) { await run(content, { ...options, obfuscate: false }, true); return true; }
module.exports = { build, validate, target, obfuscation, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_BUILD_MS };
