'use strict';
const fs = require('fs/promises'), path = require('path');
const { download, installed, sha256, tarFiles } = require('./script-tool-install');
const lua = require('./install-lua-runtime');
const compatibility = require('./prometheus-compat');
const VERSION = '0.2.11.1';
const ASSETS = {
  'linux-x64': ['linux', '87cc0330a0a8297703d319fa241ba60ed0fcdb433cc299e8e196aa31ec10c804'],
  'darwin-arm64': ['macos', '8e08b381c29bc69b10a0cf26c00b7487278389b109b6b6f83ea0fbd48d015d84'],
};
const folder = path.resolve(__dirname, '../tools/prometheus');
const executable = path.join(folder, 'runtime/lua'), cli = path.join(folder, 'cli.lua');
function filesFromArchive(gzip, prefix) {
  const files = tarFiles(gzip, prefix, relative => {
    if (!(relative.startsWith('src/') && relative.endsWith('.lua') || ['LICENSE', 'README.md', 'cli.lua', 'prometheus-lua', 'runtime/lua'].includes(relative))) throw Error('Unexpected official release file');
    return true;
  });
  if (!files.has('runtime/lua') || !files.has('cli.lua') || !files.has('src/prometheus/pipeline.lua') || !files.has('LICENSE')) throw Error('Incomplete official Prometheus release');
  return files;
}
async function install() {
  const asset = ASSETS[process.platform + '-' + process.arch];
  if (!asset) { console.log('Prometheus is unavailable on this architecture; obfuscated builds will fail explicitly.'); return; }
  const required = ['LICENSE', 'runtime/LICENSE.txt', 'AUDIT-HUB-COMPATIBILITY.txt', ...(process.platform === 'linux' ? ['runtime/source.json'] : [])];
  let sourceValid = process.platform !== 'linux';
  if (!sourceValid) {
    try { const source = JSON.parse(await fs.readFile(path.join(folder, 'runtime/source.json'), 'utf8')); sourceValid = source.version === lua.VERSION && source.archiveSha256 === lua.ARCHIVE_SHA256; } catch {}
  }
  let compatibilityValid = false;
  try { const metadata = JSON.parse(await fs.readFile(path.join(folder, 'installed.json'), 'utf8')); compatibilityValid = metadata.compatibilityVersion === compatibility.VERSION; } catch {}
  if (sourceValid && compatibilityValid && await installed(folder, VERSION, asset[1], required)) { console.log('Prometheus ' + VERSION + ' already installed and verified.'); return; }
  const name = 'prometheus-lua-v' + VERSION + '-' + asset[0];
  const archive = await download('https://github.com/prometheus-lua/Prometheus/releases/download/v' + VERSION + '/' + name + '.tar.gz', asset[1], 2 * 1024 * 1024);
  const files = compatibility.patchFiles(filesFromArchive(archive, name));
  await fs.mkdir(path.dirname(folder), { recursive: true });
  const staged = await fs.mkdtemp(path.join(path.dirname(folder), '.prometheus-install-'));
  try {
    const hashes = {};
    for (const [relative, bytes] of files) {
      const target = path.join(staged, relative); await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { mode: relative === 'runtime/lua' ? 0o755 : 0o600 }); hashes[relative] = sha256(bytes);
    }
    await fs.chmod(path.join(staged, 'runtime/lua'), 0o755);
    const runtimeSource = process.platform === 'linux' ? await lua.buildRuntime(staged) : null;
    if (!runtimeSource) await fs.copyFile(path.resolve(__dirname, '../licenses/LUA-LICENSE.txt'), path.join(staged, 'runtime/LICENSE.txt'));
    hashes['runtime/lua']=sha256(await fs.readFile(path.join(staged,'runtime/lua')));
    hashes['runtime/LICENSE.txt']=sha256(await fs.readFile(path.join(staged,'runtime/LICENSE.txt')));
    if (runtimeSource) hashes['runtime/source.json']=sha256(await fs.readFile(path.join(staged,'runtime/source.json')));
    await fs.writeFile(path.join(staged, 'installed.json'), JSON.stringify({ version: VERSION, archiveSha256: asset[1], compatibilityVersion: compatibility.VERSION, ...(runtimeSource ? { runtimeSource } : {}), files: hashes }) + '\n', { mode: 0o600 });
    await fs.rm(folder, { recursive: true, force: true }); await fs.rename(staged, folder);
  } finally { await fs.rm(staged, { recursive: true, force: true }); }
  console.log('Installed pinned Prometheus ' + VERSION + ' with ' + compatibility.VERSION + ', verified SHA-256 and retained LICENSE.');
}
if (require.main === module) install().catch(() => { console.error('Pinned Prometheus installation failed; obfuscation remains unavailable.'); process.exitCode = 1; });
module.exports = { VERSION, COMPATIBILITY_VERSION: compatibility.VERSION, folder, executable, cli, install, filesFromArchive, ASSETS };
