'use strict';
async function install() {
  await Promise.all([require('./install-darklua').install(), require('./install-prometheus').install(), require('./install-luau').install()]);
}
if (require.main === module) install().catch(() => { console.error('Pinned script tool installation failed; affected builds remain unavailable.'); process.exitCode = 1; });
module.exports = { install };
