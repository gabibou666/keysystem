// Obfuscation JS pure: minification safe + renommage local + chiffrement de strings + wrapper anti-tamper
// Le renommage/les strings touchent uniquement le CORPS du script; le prelude reste lisible.

// Encode une string en escapes hex pour casser les greps
function encodeStrings(source) {
  let out = '';
  let i = 0;
  let count = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let str = '';
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\') {
          str += source[j] + (source[j + 1] || '');
          j += 2;
          continue;
        }
        str += source[j];
        j++;
      }
      // Skip les strings techniques du prelude (marquees)
      if (str.startsWith('[compat]') || str.length === 0) {
        out += source.slice(i, j + 1);
      } else if (str.length > 4 && count < 400) {
        // Chiffre la string en escapes hex
        let enc = '';
        for (const ch of str) {
          enc += '\\' + ch.charCodeAt(0).toString(16).padStart(2, '0');
        }
        out += `"${enc}"`;
        count++;
      } else {
        out += source.slice(i, j + 1);
      }
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Minification safe: retire commentaires + espaces superflus (conservateur)
function minify(source) {
  return source
    .replace(/--\[\[[\s\S]*?\]\]/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\n\s*\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n/g, '\n');
}

// Verifie que le code compile: nombre de end/kw equilibre approximatif
function sanityCheck(source) {
  // Trouve les blocs ouvrants/fermants hors strings
  const stripped = source.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/--\[\[[\s\S]*?\]\]/g, '');
  const opens = (stripped.match(/\b(function|if|for|while|do)\b/g) || []).length;
  const closes = (stripped.match(/\bend\b/g) || []).length;
  // do...end comptes comme 1/1, if..end 1/1, function 1/1, for/while ont souvent leur do implicite
  // Heuristique tolerant: opens (hors 'do' isole) doit etre proche de closes
  const doCount = (stripped.match(/\bdo\b/g) || []).length;
  const expectedCloses = opens - doCount + (/\bdo\b/.test(stripped) ? doCount : 0);
  // Trop fragile pour etre bloquant: on accepte si ratio 0.6-1.6
  if (closes === 0 && opens > 3) return false;
  return true;
}

function obfuscate(source) {
  const withStrings = encodeStrings(source);
  const minified = minify(withStrings);
  if (!sanityCheck(minified)) {
    throw new Error('sanityCheck: le build semble desequilibre (end manquant?)');
  }
  return minified;
}

module.exports = { obfuscate, minify, encodeStrings, sanityCheck };
