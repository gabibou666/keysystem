// Obfuscation fiable par scanner positionnel:
// - scan() identifie precisement strings et commentaires (plus de regex, plus de code mange)
// - les strings sont encodees en \xNN en PRESERVANT les echappements (\n, \t, \ddd...)
// - les commentaires sont supprimes proprement
// - validateStructure() prouve que le squelette code est IDENTIQUE a l'original

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
      // Commentaire long --[[ ]] (avec niveaux [=[ ]=])
      const longOpen = source.slice(i + 2).match(/^(\[=*\[)/);
      if (longOpen) {
        const open = longOpen[1];
        const close = open.replace(/\[/g, ']');
        let end = source.indexOf(close, i + 2 + open.length);
        end = end === -1 ? n : end + close.length;
        push('comment', i, end);
        i = end;
      } else {
        // Commentaire ligne: jusqu'au \n (exclu)
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
      // j === quote fermante (ou n si non fermee: on prend tout)
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

// Encode le contenu d'une string quotee en escapes hex, PRESERVANT les sequences d'echappement
function encodeLuaStringContent(content) {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '\\') {
      // sequence d'echappement: conserver telle quelle (\n, \t, \", \\, \ddd, \xNN, \z...)
      let seq = '\\';
      i++;
      if (i < content.length) {
        if (/[0-9]/.test(content[i])) {
          let d = 0;
          while (d < 3 && i < content.length && /[0-9]/.test(content[i])) {
            seq += content[i];
            i++;
            d++;
          }
        } else if (content[i] === 'x') {
          seq += content[i];
          i++;
          let d = 0;
          while (d < 2 && i < content.length && /[0-9a-fA-F]/.test(content[i])) {
            seq += content[i];
            i++;
            d++;
          }
        } else {
          seq += content[i];
          i++;
        }
      }
      out += seq;
    } else {
      out += '\\' + content.charCodeAt(i).toString(16).padStart(2, '0');
      i++;
    }
  }
  return out;
}

// Squelette code: source sans strings (remplacees par placeholder) ni commentaires.
// L'obfuscateur ne touchant QUE strings/commentaires, squelette(build) === squelette(original).
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

// Obfuscation: strings encodees + commentaires supprimes. Le CODE reste identique.
function obfuscate(source) {
  const segs = scan(source);
  let out = '';
  let pos = 0;
  let encoded = 0;
  for (const s of segs) {
    out += source.slice(pos, s.start);
    if (s.type === 'comment') {
      // supprime (remplace par rien)
    } else if (s.type === 'string') {
      const raw = source.slice(s.start, s.end);
      const quote = raw[0];
      if (quote === '"' || quote === "'") {
        const content = raw.slice(1, raw.length - (raw.endsWith(quote) ? 1 : 0));
        // Skip: strings techniques du prelude et tres courtes (pas de gain)
        if (content.includes('[compat]') || content.length <= 3) {
          out += raw;
        } else {
          out += quote + encodeLuaStringContent(content) + (raw.endsWith(quote) ? quote : '');
          encoded++;
        }
      } else {
        // long string [[...]]: conservee telle quelle (encodage multi-ligne impossible)
        out += raw;
      }
    }
    pos = s.end;
  }
  out += source.slice(pos);
  return out;
}

// Validation structurelle: le squelette du build doit etre IDENTIQUE a l'original
function validateStructure(original, build) {
  const a = codeSkeleton(original);
  const b = codeSkeleton(build);
  if (a !== b) {
    // trouve la premiere divergence pour le message
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    return {
      ok: false,
      message: `structure divergente a l'offset ${i}: "${a.slice(Math.max(0, i - 30), i + 30)}" vs "${b.slice(Math.max(0, i - 30), i + 30)}"`,
    };
  }
  return { ok: true };
}

module.exports = { obfuscate, scan, codeSkeleton, validateStructure, encodeLuaStringContent };
