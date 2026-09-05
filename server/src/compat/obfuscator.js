// Obfuscation fiable par scanner positionnel + PREUVE ROUND-TRIP:
// - scan() identifie precisement strings et commentaires (plus de regex, plus de code mange)
// - les strings sont encodees en \xNN (hex, Luau) en PRESERVANT les echappements (\n, \t, \ddd...)
// - chars non-ASCII (emojis, accents) conserves litteralement (UTF-8 passe tel quel)
// - decodeLuau() : chaque string encodee est DECODEE ET COMPAREE a l'original
//   => toute divergence = string laissee litterale. Un build servi est PROUVE correct.

// Scan positionnel: segments {type: 'code'|'string'|'comment', start, end}
function scan(source) {
  const segs = [];
  const push = (type, start, end) => segs.push({ type, start, end });
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];

    // --- Commentaires ---
    if (c === '-' && source[i + 1] === '-') {
      const longOpen = source.slice(i + 2).match(/^(\[=*\[)/);
      if (longOpen) {
        const open = longOpen[1];
        const close = open.replace(/\[/g, ']');
        let end = source.indexOf(close, i + 2 + open.length);
        end = end === -1 ? n : end + close.length;
        push('comment', i, end);
        i = end;
      } else {
        let nl = source.indexOf('\n', i);
        const end = nl === -1 ? n : nl;
        push('comment', i, end);
        i = end;
      }
      continue;
    }

    // --- Strings quotees ---
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      push('string', i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }

    // --- Long strings [[...]] (et [=[...]=]) ---
    if (c === '[') {
      const open = source.slice(i).match(/^(\[=*\[)/);
      if (open) {
        const o = open[1];
        const close = o.replace(/\[/g, ']');
        let end = source.indexOf(close, i + o.length);
        end = end === -1 ? n : end + close.length;
        push('string', i, end);
        i = end;
        continue;
      }
    }

    i++;
  }
  return segs;
}

// Decodeur Lua COMPLET (semantique officielle): \ddd, \xNN, \n \t \r \a \b \f \v \" \' \\ \z
// Sert a la PREUVE ROUND-TRIP: decode(encode(x)) === decode(x)
function decodeLuau(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    // escape
    const d = content[i + 1];
    if (d === undefined) {
      out += '\\';
      i++;
      continue;
    }
    if (/[0-9]/.test(d)) {
      let digits = '';
      let j = i + 1;
      while (digits.length < 3 && j < n && /[0-9]/.test(content[j])) {
        digits += content[j];
        j++;
      }
      out += String.fromCharCode(parseInt(digits, 10));
      i = j;
    } else if (d === 'x') {
      const h = content.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(h)) {
        out += String.fromCharCode(parseInt(h, 16));
        i += 4;
      } else {
        out += '\\x';
        i += 2;
      }
    } else if (d === 'z') {
      i += 2;
      while (i < n && /\s/.test(content[i])) i++;
    } else {
      const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\x08', f: '\x0C', v: '\x0B', '"': '"', "'": "'", '\\': '\\' };
      if (map[d] !== undefined) out += map[d];
      else out += '\\' + d;
      i += 2;
    }
  }
  return out;
}

// Encode le contenu d'une string quotee:
// - sequences d'echappement existantes PRESERVEES telles quelles (deja valides cote Lua)
// - ASCII escapable (0-127) -> \xNN (hex Luau)
// - non-ASCII (accents, emojis, charCode >= 128) -> LITERAL (UTF-8 passe tel quel)
function encodeLuaStringContent(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c === '\\') {
      // sequence d'echappement existante: conserver telle quelle
      // (\ddd jusqu'a 3 chiffres, \xNN, \z, ou escape 1 char)
      let seq = '\\';
      i++;
      if (i < n) {
        const d = content[i];
        if (/[0-9]/.test(d)) {
          let cnt = 0;
          while (cnt < 3 && i < n && /[0-9]/.test(content[i])) {
            seq += content[i];
            i++;
            cnt++;
          }
        } else if (d === 'x') {
          seq += 'x';
          i++;
          let cnt = 0;
          while (cnt < 2 && i < n && /[0-9a-fA-F]/.test(content[i])) {
            seq += content[i];
            i++;
            cnt++;
          }
        } else {
          seq += content[i];
          i++;
        }
      }
      out += seq;
    } else if (content.charCodeAt(i) < 128) {
      out += '\\x' + content.charCodeAt(i).toString(16).padStart(2, '0');
      i++;
    } else {
      // non-ASCII (UTF-8 multi-bytes): passe litteral
      out += c;
      i++;
    }
  }
  return out;
}

// Squelette code: source sans strings (remplacees par placeholder) ni commentaires.
function codeSkeleton(source) {
  const segs = scan(source);
  let out = '';
  let pos = 0;
  for (const s of segs) {
    out += source.slice(pos, s.start);
    if (s.type === 'string') out += '"S"';
    pos = s.end;
  }
  out += source.slice(pos);
  return out.replace(/\s+/g, ' ').trim();
}

// PREUVE ROUND-TRIP d'une string encodee:
// decodeLuau(encode(content)) === decodeLuau(content) => l'encoding est PROUVE identique
function roundTripOk(content, encoded) {
  return decodeLuau(encoded) === decodeLuau(content);
}

// Obfuscation: strings encodees (si round-trip prouve) + commentaires supprimes.
function obfuscate(source) {
  const segs = scan(source);
  let out = '';
  let pos = 0;
  let encoded = 0;
  let skipped = 0;
  for (const s of segs) {
    out += source.slice(pos, s.start);
    if (s.type === 'comment') {
      // supprime
    } else if (s.type === 'string') {
      const raw = source.slice(s.start, s.end);
      const quote = raw[0];
      if (quote === '"' || quote === "'") {
        const content = raw.slice(1, raw.length - (raw.endsWith(quote) ? 1 : 0));
        if (content.includes('[compat]') || content.length <= 3) {
          out += raw; // strings techniques du prelude / trop courtes
        } else {
          const enc = encodeLuaStringContent(content);
          if (roundTripOk(content, enc)) {
            out += quote + enc + (raw.endsWith(quote) ? quote : '');
            encoded++;
          } else {
            // PREUVE ECHOUEE: on garde la string litterale (fiabilite absolue)
            out += raw;
            skipped++;
          }
        }
      } else {
        out += raw; // long string [[...]]: conservee
      }
    }
    pos = s.end;
  }
  out += source.slice(pos);
  obfuscate.lastStats = { encoded, skipped };
  return out;
}

// Validation structurelle: squelette du build === squelette de l'original
function validateStructure(original, build) {
  const a = codeSkeleton(original);
  const b = codeSkeleton(build);
  if (a !== b) {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    return {
      ok: false,
      message: `structure divergente a l'offset ${i}`,
    };
  }
  return { ok: true };
}

module.exports = { obfuscate, scan, codeSkeleton, validateStructure, encodeLuaStringContent, decodeLuau, roundTripOk };
