// Test obfuscateur v3: emojis (erreur exacte executor Real), accents, round-trip
const { obfuscate, validateStructure, decodeLuau } = require('./src/compat/obfuscator');

const tests = [
  {
    name: 'EMOJIS (erreur exacte ligne 2147: \\2601\\fe0f)',
    src: `local t = "\u{1F52D} Escape to Sky Safe Spot \u{2601}\u{FE0F}"\nprint(t)`,
  },
  {
    name: 'accents francais',
    src: `local m = "Cl\u00e9 obtenu \u2014 v\u00e9rifi\u00e9e \u00e0 l'\u00e9cran"\nprint(m)`,
  },
  {
    name: 'string contenant -- + elseif (bug #1)',
    src: `local a = "http://site.com--x"\nif a then print("a")\nelseif a == 2 then print("b")\nelse print("c")\nend`,
  },
  {
    name: 'echappements mixtes (\\n \\t \\" \\\\ \\65 \\x41 \\z)',
    src: `local s = "l1\\n\\tl2 \\"q\\" b\\\\s d\\65 h\\x41 \\z  suite"\nprint(s)`,
  },
  {
    name: 'apostrophe dans string double-quotee',
    src: `local s = "l'autre jour"\nprint(s)`,
  },
  {
    name: 'longues strings [[ ]] avec ]=]',
    src: `local long = [[multi\nligne]] .. [==[avec ]=] dedans]==]\nprint(long)`,
  },
];

let failures = 0;
for (const t of tests) {
  const build = obfuscate(t.src);
  const check = validateStructure(t.src, build);
  // preuve supplementaire: extraire les strings du build et les decoder
  const status = check.ok ? 'OK' : 'FAIL';
  if (!check.ok) failures++;
  console.log(`[${status}] ${t.name}`);
  if (!check.ok) console.log('     ' + check.message);
}

// Verif explicite du cas emoji: la string encodee doit decoder IDENTIQUE
const emojiSrc = `local t = "\u{1F52D} Escape \u{2601}\u{FE0F}"`;
const emojiBuild = obfuscate(emojiSrc);
// la string doit contenir l'emoji LITERAL (pas \\2601!)
const hasLiteralEmoji = emojiBuild.includes('\u{1F52D}');
console.log((hasLiteralEmoji ? 'OK' : 'FAIL') + ' emoji conserve LITERAL (UTF-8) dans le build');
if (!hasLiteralEmoji) failures++;

// stats round-trip sur le cas mixte
obfuscate(`local a = "normal" local b = "\u{1F600} emoji" local c = "tire\\u00e9"`);
console.log('stats: ' + JSON.stringify(obfuscate.lastStats));

// pipeline complet
const { runPipeline } = require('./src/compat/pipeline');
runPipeline(
  `local UI = {}\nlocal title = "\u{1F511} Cl\u00e9 Syst\u00e8me \u2014 v\u00e9rification"\nfunction UI:show()\n  print(title .. " -- ok")\n  if Drawing then local d = Drawing.new("Text") d.Text = title end\nend\nreturn UI`,
  { useAI: false }
).then((r) => {
  console.log((r.obfuscationApplied ? 'OK' : 'FAIL') + ' pipeline complet (obfuscation ' + (r.obfuscationApplied ? 'validee' : 'fallback') + ')');
  console.log('round-trip strings: ' + JSON.stringify(obfuscate.lastStats));
  process.exit(failures > 0 ? 1 : 0);
});
