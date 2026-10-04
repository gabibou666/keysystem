'use strict';
const { sha256 } = require('./script-tool-install');
const VERSION = 'ah-compat-1';
// A narrow correction to upstream Vmify's dependency annotations. Indexed
// table reads may run __index or depend on an earlier table write. Mark them
// as ordered effects, consistently with upstream's ordinary IndexExpression,
// so instruction shuffling cannot read a method before it has been assigned.
// No new AST transform, decoder or obfuscation algorithm is introduced.
const PATCHES = [
  {
    file: 'src/prometheus/compiler/expressions/pass_self_function_call.lua',
    originalHash: 'eec2c9fd4d02ca926ed63f200edb12c4a2556eb70b793ba228d87786980fad2c', count: 2,
    before: 'self:addStatement(self:setRegister(scope, tmpReg, Ast.IndexExpression(self:register(scope, baseReg), self:register(scope, tmpReg))), {tmpReg}, {baseReg, tmpReg}, false);'
  },
  {
    file: 'src/prometheus/compiler/statements/pass_self_function_call.lua',
    originalHash: '37c3037709716f3999ba599e7963ad04ee6df22fb667320bc9eafdb62aacb82a', count: 1,
    before: 'self:addStatement(self:setRegister(scope, tmpReg, Ast.IndexExpression(self:register(scope, baseReg), self:register(scope, tmpReg))), {tmpReg}, {tmpReg, baseReg}, false);'
  },
  {
    file: 'src/prometheus/compiler/statements/function_declaration.lua',
    originalHash: '264ad68162797bd43998d52cc126bf925ee68613a10ff78d7e3f5ecd8f216f4d', count: 1,
    before: 'self:addStatement(self:setRegister(scope, tblReg, Ast.IndexExpression(self:register(scope, tblRegOld), self:register(scope, indexReg))), {tblReg}, {tblReg, indexReg}, false);'
  }
];
function replaceExact(source, before, after, count = 1) {
  const segments = source.split(before);
  if (segments.length - 1 !== count) throw Error('Unexpected upstream patch locations');
  return segments.join(after);
}
function patchFiles(files) {
  for (const patch of PATCHES) {
    const bytes = files.get(patch.file);
    if (!bytes || sha256(bytes) !== patch.originalHash) throw Error('Unexpected upstream source for audited compatibility patch');
    const source = bytes.toString('utf8');
    const after = patch.before.replace(', false);', ', true);');
    const modified = replaceExact(source, patch.before, after, patch.count);
    files.set(patch.file, Buffer.from('-- AUDIT HUB ' + VERSION + ': ordered indexed reads; based on Prometheus v0.2.11.1.\n' + modified));
  }
  files.set('AUDIT-HUB-COMPATIBILITY.txt', Buffer.from('Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus\n\nThis distribution uses Prometheus v0.2.11.1 with the AUDIT HUB ' + VERSION + ' compatibility patch. Indexed-read dependencies are ordered, matching upstream ordinary table indexing, so randomized instruction scheduling cannot retrieve a method before its declaration. The original upstream source SHA-256 and exact replacement counts are checked before modification. No obfuscation transform is added.\n'));
  return files;
}
module.exports = { VERSION, PATCHES, patchFiles };
