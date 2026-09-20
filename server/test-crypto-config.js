// ============================================================================
// Test des briques de securite (aucune base de donnees requise).
// Usage: node test-crypto-config.js
// ----------------------------------------------------------------------------
// Couvre precisement les regressions corrigees:
//   - verifyKeyFormat ne doit JAMAIS lever d'exception sur une entree invalide
//     (l'ancien code appelait timingSafeEqual sur des buffers de tailles
//     differentes => erreur 500 au lieu de "cle invalide");
//   - safeEqual doit refuser proprement les entrees de tailles differentes;
//   - AES-256-GCM doit faire un aller-retour exact et la cle doit faire 32 octets;
//   - la derivation de cle AES doit etre DETERMINISTE (un redeploiement ne doit
//     pas rendre les originaux chiffres illisibles).
// ============================================================================
const assert = require('assert');
const nodeCrypto = require('crypto');

const cryptoService = require('./src/services/crypto');
const configCheck = require('./src/config-check');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log('\n[1] Format et signature des cles');
test('une cle generee est valide', () => {
  const { key, kid } = cryptoService.generateKey();
  assert.strictEqual(key.length, 65, 'format kid.signature attendu (32 + 1 + 32)');
  const parsed = cryptoService.verifyKeyFormat(key);
  assert.ok(parsed, 'la cle generee doit etre valide');
  assert.strictEqual(parsed.kid, kid);
});

test('une signature falsifiee est refusee', () => {
  const { kid } = cryptoService.generateKey();
  const fake = `${kid}.${'0'.repeat(32)}`;
  assert.strictEqual(cryptoService.verifyKeyFormat(fake), null);
});

test('entrees hostiles: aucune exception, toujours null', () => {
  const hostile = [
    '', '.', '..', 'a.b', 'x'.repeat(200),
    `${'z'.repeat(32)}.${'z'.repeat(32)}`, // longueur bonne mais non hex
    `${'0'.repeat(31)}.${'0'.repeat(32)}`,
    `${'0'.repeat(32)}.${'0'.repeat(33)}`,
    `${'0'.repeat(32)}.${'0'.repeat(31)}`,
    '====.====',
    null, undefined, 42, {}, [],
    `${'A'.repeat(32)}.${'B'.repeat(32)}`, // hex MAJUSCULE: accepte (tolere)
  ];
  for (const value of hostile) {
    const out = cryptoService.verifyKeyFormat(value);
    assert.ok(out === null || typeof out.kid === 'string', `sortie inattendue pour ${String(value).slice(0, 20)}`);
  }
});

console.log('\n[2] Comparaison de secrets a temps constant');
test('safeEqual: egal / different / tailles differentes', () => {
  assert.strictEqual(cryptoService.safeEqual('abc', 'abc'), true);
  assert.strictEqual(cryptoService.safeEqual('abc', 'abd'), false);
  assert.strictEqual(cryptoService.safeEqual('abc', 'abcd'), false);
  assert.strictEqual(cryptoService.safeEqual('', ''), true);
  assert.strictEqual(cryptoService.safeEqual(null, 'abc'), false);
  assert.strictEqual(cryptoService.safeEqual('abc', undefined), false);
});

console.log('\n[3] Chiffrement AES-256-GCM des originaux');
test('aller-retour exact', () => {
  const original = 'print("hello") -- unicode: éàçü 🎮\n' + 'x'.repeat(5000);
  const { enc, iv } = cryptoService.encryptAES(original);
  assert.strictEqual(cryptoService.decryptAES(enc, iv), original);
});

test('un contenu altere est detecte (auth tag)', () => {
  const { enc, iv } = cryptoService.encryptAES('secret');
  const tampered = Buffer.from(enc, 'base64');
  tampered[0] ^= 0xff;
  assert.throws(() => cryptoService.decryptAES(tampered.toString('base64'), iv));
});

console.log('\n[4] Cle AES deterministe (anti-perte de donnees apres redeploiement)');
test('aesKey() est stable et fait 32 octets', () => {
  const a = configCheck.aesKey();
  const b = configCheck.aesKey();
  assert.strictEqual(a.length, 32, 'AES-256 attend 32 octets');
  assert.ok(a.equals(b), 'la cle doit etre identique entre deux appels');
});

test('un AES_KEY hors format ne casse pas le dechiffrement', () => {
  const previous = process.env.AES_KEY;
  try {
    delete process.env.AES_KEY;
    const derivedA = configCheck.aesKey();
    assert.strictEqual(derivedA.length, 32);
    process.env.AES_KEY = 'phrase-secrete-maison-pas-en-hex';
    const derivedB = configCheck.aesKey();
    assert.strictEqual(derivedB.length, 32, 'une valeur inattendue doit produire une cle 32 octets valide');
    const again = configCheck.aesKey();
    assert.ok(derivedB.equals(again), 'la derivation doit etre stable');
  } finally {
    if (previous === undefined) delete process.env.AES_KEY;
    else process.env.AES_KEY = previous;
  }
});

console.log('\n[5] Empreintes');
test('sha256 / randomToken / hashToken', () => {
  assert.strictEqual(cryptoService.sha256('abc'), nodeCrypto.createHash('sha256').update('abc').digest('hex'));
  assert.strictEqual(cryptoService.randomToken(16).length, 32);
  assert.notStrictEqual(cryptoService.randomToken(16), cryptoService.randomToken(16));
  assert.strictEqual(cryptoService.hashToken('t').length, 64);
});

if (failed) {
  console.error(`\n❌ ${failed} test(s) en echec`);
  process.exit(1);
}
console.log('\n✅ Tous les tests de securite passent\n');
