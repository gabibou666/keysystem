'use strict';
// Prometheus's Linux release runtime requires glibc 2.38. Build the unchanged
// official Lua 5.1 interpreter during installation against the host libc;
// Render's Debian 12 native build already includes gcc and make.
const fs = require('fs/promises'), path = require('path'), { spawn } = require('child_process');
const { download, tarFiles, sha256 } = require('./script-tool-install');
const VERSION = '5.1.5';
const ARCHIVE_SHA256 = '2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333';
const archiveURL = 'https://www.lua.org/ftp/lua-' + VERSION + '.tar.gz';
function sourceFiles(bytes) {
  if (sha256(bytes) !== ARCHIVE_SHA256) throw Error('Official Lua source checksum mismatch');
  const files = tarFiles(bytes, 'lua-' + VERSION, name => name === 'COPYRIGHT' || /^src\/[A-Za-z0-9_.-]+\.(c|h)$/.test(name) || name === 'src/Makefile', 4 * 1024 * 1024);
  if (!files.has('COPYRIGHT') || !files.has('src/lua.c') || !files.has('src/Makefile')) throw Error('Incomplete official Lua source');
  return files;
}
async function compile(sourceRoot, compiler = 'gcc') {
  if (!['gcc', 'cc'].includes(compiler)) throw Error('Unsupported compiler');
  await new Promise((resolve, reject) => {
    // The generic target links only libm and the static Lua library. Neither
    // readline nor a dynamically loaded Lua library is needed by the worker.
    const child = spawn('/usr/bin/make', ['-C', path.join(sourceRoot, 'src'), 'generic', 'CC=' + compiler], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }, shell: false,
      cwd: sourceRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let finished = false, limit, bytes = 0, killTimer;
    const killGroup = signal => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    const stop = () => { if (finished || limit) return; limit = true; killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), 250); };
    const timer = setTimeout(stop, 60000);
    const consume = chunk => { bytes += chunk.length; if (bytes > 65536) stop(); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    const finish = error => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer); error ? reject(error) : resolve(); };
    child.once('error', () => finish(Error('Official Lua compiler toolchain unavailable')));
    child.once('close', code => finish(code === 0 && !limit ? null : Error('Official Lua runtime compilation failed or exceeded its limit')));
  });
}
async function buildRuntime(staged, archive, compiler = 'gcc') {
  const files = sourceFiles(archive || await download(archiveURL, ARCHIVE_SHA256, 512 * 1024));
  const sourceRoot = await fs.mkdtemp(path.join(path.dirname(staged), '.lua-source-'));
  try {
    for (const [relative, bytes] of files) {
      const target = path.join(sourceRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { mode: 0o600 });
    }
    await compile(sourceRoot, compiler);
    await fs.mkdir(path.join(staged, 'runtime'), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, 'src/lua'), path.join(staged, 'runtime/lua'));
    await fs.chmod(path.join(staged, 'runtime/lua'), 0o755);
    await fs.copyFile(path.join(sourceRoot, 'COPYRIGHT'), path.join(staged, 'runtime/LICENSE.txt'));
    await fs.writeFile(path.join(staged, 'runtime/source.json'), JSON.stringify({ version: VERSION, archiveSha256: ARCHIVE_SHA256, sourceURL: archiveURL, buildTarget: 'generic' }) + '\n', { mode: 0o600 });
    return { version: VERSION, archiveSha256: ARCHIVE_SHA256 };
  } finally { await fs.rm(sourceRoot, { recursive: true, force: true }); }
}
module.exports = { VERSION, ARCHIVE_SHA256, archiveURL, sourceFiles, compile, buildRuntime };
