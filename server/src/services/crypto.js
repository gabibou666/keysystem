const crypto = require('crypto');

const HMAC_SECRET = process.env.HMAC_SECRET || 'dev-secret';
const AES_KEY = Buffer.from(
  (process.env.AES_KEY || '').length === 64
    ? process.env.AES_KEY
    : crypto.randomBytes(32).toString('hex'),
  'hex'
);

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
  if (parts.length !== 2 || parts[0].length !== 32 || parts[1].length !== 32) return null;
  const kid = parts[0];
  const expected = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(kid)
    .digest('hex')
    .slice(0, 32);
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  return { kid, signature: parts[1] };
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
  const tag = raw.slice(raw.length - 16);
  const data = raw.slice(0, raw.length - 16);
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

module.exports = { generateKey, verifyKeyFormat, encryptAES, decryptAES, sha256, randomToken, hashToken };
