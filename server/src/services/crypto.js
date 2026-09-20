const crypto = require('crypto');
const { secret, aesKey } = require('../config-check');

// Secrets via l'environnement (voir src/config-check.js).
// ATTENTION: plus aucun fallback silencieux de type 'dev-secret' (forgeable par
// n'importe qui) et plus d'AES_KEY aleatoire par processus (elle rendait les
// originaux chiffres illisibles apres chaque redeploiement).
const HMAC_SECRET = secret('HMAC_SECRET');
const AES_KEY = aesKey();

// ---------- Cles HMAC (format: kid.signature) ----------
function generateKey() {
  const kid = crypto.randomBytes(16).toString('hex');
  const signature = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(kid)
    .digest('hex')
    .slice(0, 32);
  return { key: `${kid}.${signature}`, kid, signature };
}

function verifyKeyFormat(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('.');
  // Validation stricte du format AVANT tout calcul cryptographique:
  // timingSafeEqual leve une exception si les buffers n'ont pas la meme taille,
  // et une entree non hex produirait un buffer plus court => 500 au lieu d'un
  // simple "cle invalide".
  if (parts.length !== 2) return null;
  const [kid, signature] = parts;
  if (!/^[0-9a-f]{32}$/i.test(kid) || !/^[0-9a-f]{32}$/i.test(signature)) return null;

  const expected = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(kid)
    .digest('hex')
    .slice(0, 32);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    return null;
  }
  return { kid, signature };
}

// ---------- AES-256-GCM pour le script original ----------
function encryptAES(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: Buffer.concat([enc, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

function decryptAES(encBase64, ivBase64) {
  const raw = Buffer.from(encBase64, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(0, raw.length - 16);
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Comparaison de secrets a temps constant, tolerante aux entrees invalides
// (l'ancien code appelait timingSafeEqual directement => exception + 500).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

module.exports = {
  generateKey,
  verifyKeyFormat,
  encryptAES,
  decryptAES,
  sha256,
  randomToken,
  hashToken,
  safeEqual,
};
