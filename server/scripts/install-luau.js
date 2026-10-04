'use strict';
const fs = require('fs/promises'), path = require('path');
const { download, installed, zipFile, sha256 } = require('./script-tool-install');
const VERSION = '0.741';
const ASSETS = {
  'linux-x64': ['luau-ubuntu.zip', '134dc762ad26232af83e43f98dec03ff6030dd3a4452f9408b9d50ccea025503'],
  'darwin-arm64': ['luau-macos.zip', '839cc1de39b0f765fbaea8e89421c12acfed6bd3d8d2cc2a2d3fc64bdde32b0f'],
  'win32-x64': ['luau-windows.zip', 'be90c3223f3dc26777ef234244c2b1eae16b3c574f1ab7d1446972f72c28cab1'],
};
const folder = path.resolve(__dirname, '../tools/luau');
const executable = path.join(folder, process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile');
const interpreter = path.join(folder, process.platform === 'win32' ? 'luau.exe' : 'luau');
async function install() {
  const asset = ASSETS[process.platform + '-' + process.arch]; if (!asset) throw Error('Unsupported platform for pinned Luau compiler');
  if (await installed(folder, VERSION, asset[1], ['LICENSE.txt'])) { console.log('Luau ' + VERSION + ' already installed and verified.'); return; }
  const archive = await download('https://github.com/luau-lang/luau/releases/download/' + VERSION + '/' + asset[0], asset[1]);
  await fs.mkdir(folder, { recursive: true }); const hashes = {};
  // The interpreter supports controlled repository tests only. Production
  // script-builder invokes luau-compile exclusively and never executes uploads.
  for (const target of [executable, interpreter]) {
    const name = path.basename(target), bytes = zipFile(archive, name);
    await fs.writeFile(target, bytes, { mode: 0o755 }); await fs.chmod(target, 0o755); hashes[name] = sha256(bytes);
  }
  await fs.copyFile(path.resolve(__dirname, '../licenses/LUAU-LICENSE.txt'), path.join(folder, 'LICENSE.txt'));
  hashes['LICENSE.txt']=sha256(await fs.readFile(path.join(folder,'LICENSE.txt')));
  await fs.writeFile(path.join(folder, 'installed.json'), JSON.stringify({ version: VERSION, archiveSha256: asset[1], files: hashes }) + '\n');
  console.log('Installed official Luau ' + VERSION + ' compiler with verified SHA-256.');
}
if (require.main === module) install().catch(() => { console.error('Pinned Luau compiler installation failed; script validation remains unavailable.'); process.exitCode = 1; });
module.exports = { VERSION, folder, executable, interpreter, install, ASSETS };
