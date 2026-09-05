// Lexer Lua minimal pour l'analyse de compatibilite
const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while', 'continue',
]);

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const push = (type, value, line) => tokens.push({ type, value, line });

  while (i < source.length) {
    const line = (source.slice(0, i).match(/\n/g) || []).length + 1;
    const c = source[i];

    // Whitespace
    if (/\s/.test(c)) { i++; continue; }

    // Comments
    if (c === '-' && source[i + 1] === '-') {
      if (source.slice(i, i + 4) === '--[[') {
        const end = source.indexOf(']]', i + 4);
        i = end === -1 ? source.length : end + 2;
      } else {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end + 1;
      }
      continue;
    }

    // Strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        j++;
      }
      push('string', source.slice(i, j + 1), line);
      i = j + 1;
      continue;
    }

    // Long strings [[...]]
    if (c === '[' && source[i + 1] === '[') {
      const end = source.indexOf(']]', i + 2);
      const val = source.slice(i, end === -1 ? source.length : end + 2);
      push('string', val, line);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      let j = i;
      while (j < source.length && /[0-9a-fA-FxX.eE+-]/.test(source[j])) {
        if ((source[j] === '+' || source[j] === '-') && !/[eE]/.test(source[j - 1] || '')) break;
        j++;
      }
      push('number', source.slice(i, j), line);
      i = j;
      continue;
    }

    // Identifiers
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      const word = source.slice(i, j);
      push(KEYWORDS.has(word) ? 'keyword' : 'name', word, line);
      i = j;
      continue;
    }

    // Operators
    push('op', c, line);
    i++;
  }

  return tokens;
}

// Verifie si le code reference un nom global (heuristique textuelle rapide)
function usesGlobal(source, name) {
  const re = new RegExp(
    `(^|[^\\w.])${name.replace(/[.*]/g, (m) => '\\' + m)}\\s*[({=\\[,:]|(^|[^\\w.])${name.replace(/[.*]/g, (m) => '\\' + m)}\\s*$`,
    'm'
  );
  return re.test(source);
}

module.exports = { tokenize, usesGlobal, KEYWORDS };
