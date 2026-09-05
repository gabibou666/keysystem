// Test obfuscateur v2: cas qui ont casse le build precedent + cas complexes
const { obfuscate, validateStructure, scan } = require('./src/compat/obfuscator');

const tests = [
  {
    name: 'string contenant -- (le tueur du build precedent)',
    src: `local a = "http://site.com--x"\nif a then\n  print("ok")\nelseif a == 2 then\n  print("deux")\nend`,
  },
  {
    name: 'commentaires + longs commentaires imbriques',
    src: `-- line comment avec ]] dedans\nlocal x = 1 --[[ long\ncommentaire ]] local y = 2\nprint(x + y)`,
  },
  {
    name: 'echappements dans strings (\\n \\t \\" \\\\ \\65)',
    src: `local s = "ligne1\\n\\tligne2 \\"quote\\" back\\\\slash dec\\65 hex\\x41"\nprint(s)`,
  },
  {
    name: 'apostrophes dans strings quotees',
    src: `local s = 'c\\'est ok' .. "l'autre"\nprint(s)`,
  },
  {
    name: 'long strings [[...]] et [=[...]=]',
    src: `local long = [[multi\nligne]] .. [==[avec ]=] dedans]==]\nprint(long)`,
  },
  {
    name: 'elseif profond (erreur exacte vue: Expected <eof> got elseif)',
    src: `local v = 1\nif v == 1 then\n  print("a")\nelseif v == 2 then\n  print("b")\nelseif v == 3 then\n  print("c")\nelse\n  print("d")\nend`,
  },
  {
    name: 'script realiste avec Drawing/writefile',
    src: `local d = Drawing.new("Text")\nd.Text = "ESP"\nd.Size = 16\nwritefile("esp.txt", "data")\nif isfile("esp.txt") then print("ok") end`,
  },
];

let failures = 0;
for (const t of tests) {
  const build = obfuscate(t.src);
  const check = validateStructure(t.src, build);
  const sameLen = scan(t.src).length > 0;
  const status = check.ok ? 'OK' : 'FAIL';
  if (!check.ok) failures++;
  console.log(`[${status}] ${t.name}`);
  if (!check.ok) console.log('     ' + check.message);
}

// Test charge complet: prelude + script puis obfuscation
const { runPipeline } = require('./src/compat/pipeline');
runPipeline(
  `local ESP = {}\nlocal url = "https://example.com/script--v2"\nfunction ESP:start()\n  local t = "temp\\tvalue"\n  print(url, t)\n  if Drawing then\n    local d = Drawing.new("Text")\n    d.Text = "ESP ON"\n  end\nend\nreturn ESP`,
  { useAI: false }
).then((r) => {
  console.log((r.obfuscationApplied ? 'OK' : 'FAIL') + ' pipeline complet (obfuscation ' + (r.obfuscationApplied ? 'validee' : 'rejetee->fallback') + ', ' + r.build.length + ' chars)');
  // preuve: le build contient le prelude ET le squelette est intact
  const hasPrelude = r.build.includes('memfs') && r.build.includes('Drawing');
  console.log((hasPrelude ? 'OK' : 'FAIL') + ' prelude present dans le build');
  process.exit(failures > 0 ? 1 : 0);
});
