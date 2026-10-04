'use strict';

// Static triage only. This deliberately never evaluates Lua or follows URLs.
const crypto = require('crypto');
const SCANNER_VERSION = 'static-luau-3';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOKENS = 150000;
const MAX_DECODED = 16384;
const MAX_FINDINGS = 64;

function longDelimiter(source, start) {
  if (source[start] !== '[') return null;
  let at = start + 1;
  while (source[at] === '=') at++;
  return source[at] === '[' ? { end: at + 1, close: ']' + '='.repeat(at - start - 1) + ']' } : null;
}

function tokenize(source) {
  const tokens = [];
  let at = 0, line = 1, incomplete = false, bounded = false;
  function advance(end) {
    for (; at < end; at++) if (source[at] === '\n') line++;
  }
  function push(type, value, startLine, clipped = false) {
    tokens.push({ type, value, line: startLine, clipped });
    if (tokens.length >= MAX_TOKENS) bounded = true;
  }
  while (at < source.length && !bounded) {
    const c = source[at];
    if (/\s/.test(c)) { advance(at + 1); continue; }
    if (source.startsWith('--', at)) {
      const delimiter = longDelimiter(source, at + 2);
      if (delimiter) {
        const end = source.indexOf(delimiter.close, delimiter.end);
        if (end < 0) { incomplete = true; advance(source.length); }
        else advance(end + delimiter.close.length);
      } else {
        const end = source.indexOf('\n', at + 2);
        advance(end < 0 ? source.length : end);
      }
      continue;
    }
    const startLine = line;
    const delimiter = longDelimiter(source, at);
    if (delimiter) {
      const end = source.indexOf(delimiter.close, delimiter.end);
      let value = source.slice(delimiter.end, end < 0 ? source.length : end).replace(/^\r?\n/, '');
      const clipped = value.length > MAX_DECODED;
      value = value.slice(0, MAX_DECODED);
      if (end < 0) incomplete = true;
      advance(end < 0 ? source.length : end + delimiter.close.length);
      push('string', value, startLine, clipped);
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let value = '', clipped = false, closed = false;
      advance(at + 1);
      while (at < source.length) {
        const next = source[at];
        if (next === quote) { advance(at + 1); closed = true; break; }
        if (next !== '\\') {
          if (value.length < MAX_DECODED) value += next; else clipped = true;
          advance(at + 1); continue;
        }
        advance(at + 1);
        if (at >= source.length) break;
        const escape = source[at];
        let decoded = escape;
        if (/[0-9]/.test(escape)) {
          const digits = source.slice(at, at + 3).match(/^\d{1,3}/)[0];
          decoded = String.fromCharCode(Number(digits)); advance(at + digits.length);
        } else if (escape === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(at + 1, at + 3))) {
          decoded = String.fromCharCode(parseInt(source.slice(at + 1, at + 3), 16)); advance(at + 3);
        } else if (escape === 'u' && source[at + 1] === '{') {
          const match = source.slice(at + 2, at + 10).match(/^([0-9a-f]{1,6})\}/i);
          if (match && parseInt(match[1], 16) <= 0x10ffff) {
            decoded = String.fromCodePoint(parseInt(match[1], 16)); advance(at + match[0].length + 2);
          } else { decoded = ''; advance(at + 1); incomplete = true; }
        } else if (escape === 'z') {
          advance(at + 1); while (at < source.length && /\s/.test(source[at])) advance(at + 1); decoded = '';
        } else {
          decoded = ({ n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v' })[escape] || escape;
          advance(at + 1);
        }
        if (value.length + decoded.length <= MAX_DECODED) value += decoded; else clipped = true;
      }
      if (!closed) incomplete = true;
      push('string', value, startLine, clipped); continue;
    }
    if (/[a-z_]/i.test(c)) {
      const start = at;
      while (at < source.length && /[a-z0-9_]/i.test(source[at])) at++;
      push('id', source.slice(start, at), startLine); continue;
    }
    if (/\d/.test(c)) {
      const start = at;
      while (at < source.length && /[a-z0-9_.]/i.test(source[at])) at++;
      push('number', source.slice(start, at), startLine); continue;
    }
    const operator = source.startsWith('..', at) ? '..' : c;
    advance(at + operator.length); push('symbol', operator, startLine);
  }
  return { tokens, incomplete, bounded };
}

const CAPABILITIES = new Map([
  ['request', 'network'], ['http_request', 'network'], ['httprequest', 'network'],
  ['HttpGet', 'network'], ['HttpGetAsync', 'network'], ['HttpPost', 'network'],
  ['HttpPostAsync', 'network'], ['GetAsync', 'network'], ['PostAsync', 'network'], ['RequestAsync', 'network'],
  ['readfile', 'sensitive'], ['listfiles', 'sensitive'], ['getclipboard', 'sensitive'],
  ['gethwid', 'sensitive'], ['get_hwid', 'sensitive'], ['getgenv', 'environment'], ['getfenv', 'environment'], ['setfenv', 'environment'],
  ['writefile', 'filesystem'], ['appendfile', 'filesystem'], ['delfile', 'filesystem'], ['delfolder', 'filesystem'],
  ['setclipboard', 'clipboard'], ['toclipboard', 'clipboard'],
  ['loadstring', 'dynamic'], ['load', 'dynamic'], ['require', 'module'],
  ['execute', 'process'], ['popen', 'process'], ['runcode', 'process'],
]);

function scanScript(source, options = {}) {
  const findings = [];
  const seen = new Set();
  let hasHigh = false, hasReview = false;
  const add = (rule, severity, line = 1) => {
    if (severity === 'high') hasHigh = true;
    if (severity === 'review') hasReview = true;
    const key = rule + ':' + line;
    if (!seen.has(key) && findings.length < MAX_FINDINGS) {
      seen.add(key); findings.push({ rule, severity, line });
    } else if (!seen.has(key) && severity !== 'info') {
      const replace = findings.findIndex(f => f.severity === 'info' || (severity === 'high' && f.severity === 'review'));
      if (replace >= 0) { seen.add(key); findings[replace] = { rule, severity, line }; }
    }
  };
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > (options.phase === 'output' ? MAX_OUTPUT_BYTES : MAX_BYTES)) {
    return { status: 'blocked', findings: [{ rule: 'scan_input_limit', severity: 'high', line: 1 }], scannerVersion: SCANNER_VERSION, hash: null };
  }
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const { tokens, incomplete, bounded } = tokenize(source);
  if (incomplete) add('uninspectable_syntax', 'review');
  if (bounded) add('scan_token_limit', 'review');

  // Constant propagation intentionally supports a small, bounded grammar only.
  // This catches string escapes, literal concatenation and string.char aliases;
  // functions, metatables and virtual machines remain uninspectable.
  const constants = new Map();
  const aliases = new Map(CAPABILITIES);
  const charAliases = new Set();
  let inspectionSteps = 0, inspectionBounded = false;
  const step = () => {
    if (++inspectionSteps > 2000000) { inspectionBounded = true; return false; }
    return true;
  };
  function constantAt(index, depth = 0) {
    if (depth > 8 || !step()) return null;
    let token = tokens[index];
    if (!token) return null;
    let value, end;
    if (token.type === 'string' && !token.clipped) { value = token.value; end = index + 1; }
    else if (token.type === 'id' && constants.has(token.value)) { value = constants.get(token.value); end = index + 1; }
    else if (token.value === '(') {
      const nested = constantAt(index + 1, depth + 1);
      if (!nested || tokens[nested.end]?.value !== ')') return null;
      value = nested.value; end = nested.end + 1;
    } else {
      let begin;
      if (token.value === 'string' && tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'char') begin = index + 3;
      else if (charAliases.has(token.value)) begin = index + 1;
      if (begin === undefined || tokens[begin]?.value !== '(') return null;
      value = ''; end = begin + 1;
      while (end < tokens.length && value.length < MAX_DECODED) {
        if (!step()) return null;
        if (tokens[end]?.value === ')') { end++; break; }
        if (tokens[end]?.type !== 'number') return null;
        const number = Number(tokens[end].value);
        if (!Number.isInteger(number) || number < 0 || number > 255) return null;
        value += String.fromCharCode(number); end++;
        if (tokens[end]?.value === ',') end++;
        else if (tokens[end]?.value !== ')') return null;
      }
      if (tokens[end - 1]?.value !== ')') return null;
    }
    while (tokens[end]?.value === '..') {
      const next = constantAt(end + 1, depth + 1);
      if (!next || value.length + next.value.length > MAX_DECODED) return null;
      value += next.value; end = next.end;
    }
    return { value, end };
  }
  function memberAt(index) {
    if (!step()) return null;
    const first = tokens[index];
    if (!first || first.type !== 'id') return null;
    let name = first.value, end = index + 1;
    for (let count = 0; count < 8; count++) {
      if (['.', ':'].includes(tokens[end]?.value) && tokens[end + 1]?.type === 'id') {
        name = tokens[end + 1].value; end += 2;
      } else if (tokens[end]?.value === '[') {
        const field = constantAt(end + 1);
        if (!field || tokens[field.end]?.value !== ']') break;
        name = field.value; end = field.end + 1;
      } else break;
    }
    return { name, end };
  }
  // Ordered passes handle forward local aliases without unbounded fixed points.
  for (let pass = 0; pass < 3; pass++) {
    for (let index = 0; index < tokens.length; index++) {
      if (inspectionBounded) break;
      if (tokens[index].type !== 'id' || tokens[index + 1]?.value !== '=') continue;
      if (['.', ':'].includes(tokens[index - 1]?.value)) continue;
      const name = tokens[index].value;
      const value = constantAt(index + 2);
      if (value) constants.set(name, value.value);
      let begin = index + 2, parentheses = 0;
      while (tokens[begin]?.value === '(' && parentheses < 8) { begin++; parentheses++; }
      const member = memberAt(begin);
      let end = member?.end;
      while (parentheses > 0 && tokens[end]?.value === ')') { end++; parentheses--; }
      if (member && parentheses === 0 && !['(', '{'].includes(tokens[end]?.value) && tokens[end]?.type !== 'string') {
        if (aliases.has(member.name)) aliases.set(name, aliases.get(member.name));
        if (member.name === 'char' || charAliases.has(member.name)) charAliases.add(name);
      }
    }
  }

  let networkLine = 0, sensitiveLine = 0, webhookLine = 0, dynamicLine = 0;
  let numericCount = 0, loopCount = 0, decoderCount = 0;
  const webhook = /(?:discord(?:app)?\.com|discord\.com)\/api(?:\/v\d+)?\/webhooks\/|hooks\.slack\.com\/services\//i;
  function recordCapability(capability, line) {
    switch (capability) {
      case 'network': networkLine ||= line; add('network_access', 'info', line); break;
      case 'sensitive': sensitiveLine ||= line; add('sensitive_data_access', 'review', line); break;
      case 'filesystem': add('filesystem_mutation', 'review', line); break;
      case 'clipboard': add('clipboard_write', 'info', line); break;
      case 'dynamic': dynamicLine ||= line; add('dynamic_code', 'review', line); break;
      case 'module': add('external_module', 'review', line); break;
      case 'environment': add('dynamic_environment', 'review', line); break;
      case 'process': add('process_execution', 'high', line); break;
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    if (inspectionBounded) break;
    const token = tokens[index];
    if (token.type === 'number') numericCount++;
    if (token.value === 'while' || token.value === 'repeat') loopCount++;
    if (['byte', 'char', 'bxor', 'decode', 'base64decode', 'base64_decode'].includes(token.value)) decoderCount++;
    if (token.type === 'string' || (token.type === 'id' && (constants.has(token.value) || token.value === 'string' || charAliases.has(token.value)))) {
      const constant = constantAt(index);
      if (constant && webhook.test(constant.value)) webhookLine ||= token.line;
      if (constant && tokens[index - 1]?.value === '[' && tokens[constant.end]?.value === ']'
        && ['(', '{'].includes(tokens[constant.end + 1]?.value)) recordCapability(aliases.get(constant.value), token.line);
      if (token.clipped || (token.type === 'string' && token.value.length > 1024 && /^[A-Za-z0-9+/=\s]+$/.test(token.value))) add('opaque_encoded_payload', 'review', token.line);
      // Base64 decoding is inspection of literal bytes only, never Lua evaluation.
      if (token.type === 'string' && token.value.length >= 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(token.value)) {
        const decoded = Buffer.from(token.value, 'base64').toString('utf8');
        if (webhook.test(decoded)) { webhookLine ||= token.line; add('encoded_endpoint', 'review', token.line); }
      }
    }
    if (token.type !== 'id' || ['.', ':'].includes(tokens[index - 1]?.value)) continue;
    const member = memberAt(index);
    if (['_G','_ENV','shared'].includes(token.value) && tokens[index+1]?.value==='[' && !constantAt(index+2)) add('computed_environment_member','review',token.line);
    let callAt = member?.end;
    for (let parens = 0; parens < 8 && tokens[callAt]?.value === ')'; parens++) callAt++;
    if (!member || (!['(', '{'].includes(tokens[callAt]?.value) && tokens[callAt]?.type !== 'string')) continue;
    if (['decode','base64decode','base64_decode','decrypt','decompress','bxor'].includes(member.name)) add('runtime_decoder','review',token.line);
    if ((member.name==='char'||charAliases.has(member.name)) && !constantAt(index)) add('unresolved_character_decoder','review',token.line);
    recordCapability(aliases.get(member.name), token.line);
  }
  if (webhookLine) add('webhook_endpoint', 'review', webhookLine);
  if (networkLine && webhookLine) add('webhook_network_transfer', 'high', networkLine);
  // Co-occurrence is not data-flow evidence: key caches and local settings
  // routinely coexist with HTTP. Keep these scripts out of automatic approval,
  // but allow independent review instead of irreversibly rejecting the job.
  if (networkLine && sensitiveLine) add('sensitive_network_transfer', 'review', sensitiveLine);
  if (networkLine && dynamicLine) add('remote_dynamic_code', 'review', dynamicLine);
  if ((numericCount > 512 && (loopCount || decoderCount)) || (numericCount > 64 && loopCount && decoderCount)) add('opaque_virtualized_payload', 'review');
  if (decoderCount > 12 && (dynamicLine || loopCount)) add('opaque_decoder_chain', 'review', dynamicLine || 1);
  if (inspectionBounded) add('scan_inspection_limit', 'review');
  // Opaque code is held for review even if it was uploaded already obfuscated.
  // A clear generated output never downgrades an earlier source finding.
  const status = hasHigh ? 'blocked' : hasReview ? 'review' : 'clear';
  return { status, findings, scannerVersion: SCANNER_VERSION, hash };
}

// Both phases are mandatory. An obfuscation flag cannot waive a review or a
// resource-bound finding: a generated VM is still opaque to this scanner.
function combineScans(before,after){
  const valid=scan=>scan&&['clear','review','blocked'].includes(scan.status)&&Array.isArray(scan.findings)&&scan.scannerVersion===SCANNER_VERSION&&/^[a-f0-9]{64}$/.test(scan.hash||'');
  if(!valid(before)||!valid(after))throw Error('Invalid script scan result');
  const findings=[...before.findings,...after.findings];
  const blocked=before.status==='blocked'||after.status==='blocked'||findings.some(f=>f.severity==='high');
  const review=before.status==='review'||after.status==='review'||findings.some(f=>f.severity==='review');
  return {...after,status:blocked?'blocked':review?'review':'clear',findings};
}
module.exports = { scanScript, combineScans, SCANNER_VERSION, MAX_BYTES };
