'use strict';
const fs = require('fs/promises'), crypto = require('crypto'), zlib = require('zlib');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function download(url, expectedHash, maxBytes = 20 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw Error('Official script tool release unavailable');
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw Error('Release archive exceeds size limit'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length; if (size > maxBytes) { await reader.cancel(); throw Error('Release archive exceeds size limit'); }
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  if (sha256(bytes) !== expectedHash) throw Error('Official script tool checksum mismatch');
  return bytes;
}
function zipFile(zip, expectedName, maxBytes = 10 * 1024 * 1024) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw Error('Invalid ZIP directory');
  let at = zip.readUInt32LE(end + 16); const count = zip.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw Error('Invalid ZIP entry');
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), uncompressed = zip.readUInt32LE(at + 24), nameLength = zip.readUInt16LE(at + 28), extraLength = zip.readUInt16LE(at + 30), commentLength = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (name === expectedName) {
      if (uncompressed > maxBytes || local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw Error('Invalid executable entry');
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (start + size > zip.length) throw Error('Invalid executable size');
      const bytes = zip.subarray(start, start + size), result = method === 0 ? bytes : method === 8 ? zlib.inflateRawSync(bytes, { maxOutputLength: maxBytes }) : null;
      if (!result || result.length !== uncompressed) throw Error('Invalid executable compression');
      return result;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw Error('Expected executable absent from official archive');
}
async function installed(folder, version, archiveHash, requiredFiles = []) {
  try {
    const metadata = JSON.parse(await fs.readFile(folder + '/installed.json', 'utf8'));
    if (metadata.version !== version || metadata.archiveSha256 !== archiveHash || !metadata.files || !Object.keys(metadata.files).length || requiredFiles.some(name=>!metadata.files[name])) return false;
    for (const [name, expected] of Object.entries(metadata.files)) {
      if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split('/').includes('..')) return false;
      if (sha256(await fs.readFile(folder + '/' + name)) !== expected) return false;
    }
    return true;
  } catch { return false; }
}
function tarFiles(gzip, prefix, accept, maxBytes = 16 * 1024 * 1024) {
  const tar = zlib.gunzipSync(gzip, { maxOutputLength: maxBytes }), files = new Map();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512); if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const name = text(0, 100), parent = text(345, 155), full = parent ? parent + '/' + name : name;
    const sizeText = text(124, 12).trim(), size = parseInt(sizeText || '0', 8), type = text(156, 1);
    const expectedSum = parseInt(text(148, 8).trim(), 8);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== expectedSum || !/^[0-7]*$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length || !full.startsWith(prefix + '/')) throw Error('Invalid official tar entry');
    const relative = full.slice(prefix.length + 1);
    if (relative && (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.split('/').includes('..') || relative.startsWith('/'))) throw Error('Unsafe official tar path');
    if (type === '' || type === '0') {
      if (!relative || files.has(relative)) throw Error('Duplicate or empty official release entry');
      if (accept(relative)) files.set(relative, tar.subarray(at + 512, at + 512 + size));
    } else if (type !== '5') throw Error('Links or special files are not allowed');
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
module.exports = { download, zipFile, installed, sha256, tarFiles };
