#!/usr/bin/env node
// ============================================================================
// check-design.js — garde-fou de la direction visuelle (web/design.css).
// ----------------------------------------------------------------------------
// Pourquoi: le design est un contrat, pas une preference. Sans garde-fou, une
// retouche peut reintroduire en silence ce qu'on a volontairement retire
// (neons, animations en boucle, flous couteux) ou casser l'accessibilite.
//
// Invariants verifies (direction v3 « Premium » : noir + violet) :
//   1. integrite structurelle des feuilles de style;
//   2. MOUVEMENT: seules les animations de la liste blanche sont autorisees, et
//      tout selecteur anime doit etre neutralise sous prefers-reduced-motion;
//   3. COUT: effets ambiants eteints (particules, halo du curseur), fond non
//      anime, flou d'arriere-plan plafonne;
//   4. DIRECTION: accent violet, aucun retour de neon, titre sans lueur;
//   5. HYGIENE: jetons --dx-* declares, !important justifie (liste blanche ou
//      bloc garde-fou), accolades equilibrees;
//   6. INTEGRATION: design.css charge apres style.css sur toutes les pages,
//      polish.js present et compatible CSP.
//
// Usage: node scripts/check-design.js   (appele par `npm run check`)
// ============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const read = (p) => fs.readFileSync(p, 'utf8');

const errors = [];
const warnings = [];

// Animations autorisees: une entree = une intention. Toute autre = regression
// (soit du bruit visuel, soit un cout GPU non maitrise).
const ANIM_AUTORISEES = ['dxRuleDraw', 'dxPulse'];

const ACCENT_VIOLETS = ['#8b5cf6', '#7c3aed', '#a78bfa'];
const NEON_INTERDITS = ['#22d3ee', '#06b6d4', '#d946ef', '#f0abfc', '#10b981', '#22c55e', '#4ade80', '#fbbf24'];

const IMPORTANT_AUTORISE = [
  '#ks-',
  '.ks-',
  '.logo-badge',
  '.stat-icon-wrap',
  '.badge-pill',
  '.exec-logo',
  '.g-status .status-dot',
  '.reveal',
];
const BLOCS_GARDES = ['prefers-reduced-motion', 'prefers-reduced-data', '@media print'];

const designPath = path.join(WEB, 'design.css');
if (!fs.existsSync(designPath)) {
  console.error('❌ web/design.css absent: la couche de direction visuelle manque.');
  process.exit(1);
}
const css = read(designPath);
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
const style = read(path.join(WEB, 'style.css'));
const polish = read(path.join(WEB, 'polish.js'));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Contenu du premier bloc { ... } qui suit `pattern` (accolades equilibrees). */
function blockAfter(src, pattern) {
  const at = src.indexOf(pattern);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

// ---------- 1. integrite structurelle ----------
let depth = 0;
for (const ch of clean) {
  if (ch === '{') depth++;
  else if (ch === '}') depth--;
  if (depth < 0) break;
}
if (depth !== 0) errors.push(`design.css: accolades desequilibrees (${depth})`);
if (!/\{/.test(clean)) errors.push('design.css: aucun bloc de regles detecte');
const styleDepth = (() => {
  let d = 0;
  for (const ch of style.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') d++;
    else if (ch === '}') d--;
  }
  return d;
})();
if (styleDepth !== 0) errors.push(`style.css: accolades desequilibrees (${styleDepth})`);

// ---------- 2. mouvement ----------
const keyframes = [...clean.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
const kfInconnues = keyframes.filter((k) => !ANIM_AUTORISEES.includes(k));
if (kfInconnues.length) {
  errors.push(
    `design.css: @keyframes hors liste blanche -> ${kfInconnues.join(', ')} (autorisees: ${ANIM_AUTORISEES.join(', ')})`
  );
}
const usedAnimNames = [...new Set([...clean.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)].map((m) => m[1]))].filter(
  (x) => !['none', 'inherit', 'initial'].includes(x)
);
const animFantomes = usedAnimNames.filter((k) => !keyframes.includes(k));
if (animFantomes.length) errors.push(`design.css: animation referencee mais non declaree -> ${animFantomes.join(', ')}`);

// Un corps est "anime" si une declaration animation / animation-name a une
// valeur autre que `none`. (Le regex naif `(?!none)` etait faux: le `\s*`
// pouvait ne rien consommer et laisser l'espace devant "none" satisfaire le
// negative lookahead -> animation: none etait pris pour une animation.)
function isAnimated(body) {
  const values = [...body.matchAll(/(?:^|;)\s*animation(?:-name)?\s*:\s*([^;!]*)/g)].map((m) =>
    m[1].trim().toLowerCase()
  );
  return values.some((v) => v && v !== 'none' && !v.startsWith('none '));
}

// Tout selecteur anime hors bloc reduced-motion doit y etre neutralise.
const reduceBlock = blockAfter(clean, '@media (prefers-reduced-motion');
if (!reduceBlock) {
  errors.push('design.css: bloc prefers-reduced-motion absent');
} else {
  const withoutReduce = clean.replace(reduceBlock, '');
  const animated = new Set();
  for (const [, sel, body] of withoutReduce.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!isAnimated(body)) continue;
    sel
      .split(',')
      .map(norm)
      .filter((s) => s && !s.startsWith('@') && !s.startsWith(':'))
      .forEach((s) => animated.add(s));
  }
  const reduceNorm = norm(reduceBlock);
  const nonCouvert = [...animated].filter((s) => !reduceNorm.includes(s));
  if (nonCouvert.length) {
    errors.push(`design.css: selecteur anime non neutralise sous reduced-motion -> ${nonCouvert.join(' , ')}`);
  }
  if (!animated.size) warnings.push('design.css: aucun selecteur anime detecte (verifier la liste blanche)');
}
if (!/prefers-reduced-motion[\s\S]{0,400}animation-duration/.test(style)) {
  warnings.push('style.css: filet global prefers-reduced-motion introuvable (verifier le projet)');
}

// ---------- 3. cout visuel / GPU ----------
for (const sel of ['#ks-particles', '#ks-glow']) {
  if (!new RegExp(`${sel.replace('#', '#')}[\\s\\S]{0,200}display:\\s*none`).test(clean)) {
    errors.push(`design.css: ${sel} doit rester masque (effet ambiant)`);
  }
}
if (/html::before[^}]*animation/.test(clean)) errors.push('design.css: le fond (html::before) ne doit pas etre anime');
const blurs = [...clean.matchAll(/blur\((\d+)px\)/g)].map((m) => Number(m[1]));
const tropFlou = blurs.filter((b) => b > 14);
if (tropFlou.length) errors.push(`design.css: flou trop eleve (${tropFlou.join(', ')}px, max 14)`);

// ---------- 3 bis. boucles ambiantes heritees de style.css ----------
// style.css contient des animations d'ambiance (halo du hero, respiration des
// stats, pulsation du ticker, shimmer des boutons). Cette couche doit les
// neutraliser explicitement, sinon elles continuent de tourner en boucle: c'est
// le genre de regression invisible que ce garde-fou doit attraper.
const BOUCLES_HERITEES = [
  ['.hero::before', /\.hero::before\s*\{[^}]*animation:\s*none/s],
  ['.stat.live', /\.stat\.live\s*\{[^}]*animation:\s*none/s],
  ['.ticker-pulse', /\.ticker-pulse\s*\{[^}]*animation:/s],
  ['.activity-live .dot', /\.activity-live \.dot\s*\{[^}]*animation:/s],
  ['.btn.pulse::before', /\.btn\.pulse::before[\s\S]{0,260}display:\s*none/],
  ['.btn.shimmer::before', /\.btn\.shimmer::before[\s\S]{0,60}display:\s*none/],
];
for (const [nom, motif] of BOUCLES_HERITEES) {
  if (!motif.test(clean)) {
    errors.push(`design.css: la boucle heritee de style.css n'est pas neutralisee pour ${nom}`);
  }
}

// ---------- 4. direction visuelle ----------
const accent = (clean.match(/--color-accent:\s*(#[0-9a-f]{6})/i) || ['', ''])[1].toLowerCase();
if (!ACCENT_VIOLETS.includes(accent)) errors.push(`design.css: --color-accent doit rester violet (recu: ${accent || 'aucun'})`);
const neon = NEON_INTERDITS.filter((c) => clean.toLowerCase().includes(c));
if (neon.length) errors.push(`design.css: accent neon reintroduit -> ${neon.join(', ')}`);
const heroH1 = (clean.match(/\.hero h1\s*\{([^}]*)\}/) || ['', ''])[1];
if (!/filter:\s*none/.test(heroH1)) errors.push('.hero h1: aucune lueur toleree (filter: none attendu)');
if (/gradient/.test(heroH1) && !ACCENT_VIOLETS.some((c) => heroH1.toLowerCase().includes(c))) {
  errors.push('.hero h1: le degrade de texte doit rester dans la gamme violette');
}
if (!/background-clip:\s*text/.test(heroH1) && !/background:\s*none/.test(heroH1)) {
  warnings.push('.hero h1: ni degrade de texte ni fond neutre detecte');
}

// ---------- 5. hygiene ----------
const rootBlock = (clean.match(/:root\s*\{([^}]*)\}/) || ['', ''])[1];
const declares = [...rootBlock.matchAll(/(--dx-[\w-]+)\s*:/g)].map((m) => m[1]);
const utilises = [...new Set([...clean.matchAll(/var\((--dx-[\w-]+)/g)].map((m) => m[1]))];
const nonDeclares = utilises.filter((v) => !declares.includes(v));
if (nonDeclares.length) errors.push(`design.css: var(--dx-*) non declarees -> ${nonDeclares.join(', ')}`);

const importantHorsGarde = [];
let d = 0;
let garde = 0;
let selecteur = '';
for (const raw of css.split('\n')) {
  const l = raw.trim();
  if (/@media/.test(l) && BLOCS_GARDES.some((g) => l.includes(g))) garde = d + 1;
  if (l.includes('{') && !l.startsWith('}')) selecteur = l;
  if (/!important/.test(l) && d < garde && !IMPORTANT_AUTORISE.some((t) => selecteur.includes(t))) {
    importantHorsGarde.push(`${selecteur} ${l}`.slice(0, 90));
  }
  d += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
  if (d < garde) garde = 0;
}
if (importantHorsGarde.length) {
  errors.push(`design.css: !important hors garde-fou -> ${importantHorsGarde.slice(0, 2).join(' | ')}`);
}

// ---------- 6. integration ----------
const pages = fs.readdirSync(WEB).filter((f) => f.endsWith('.html'));
for (const page of pages) {
  const html = read(path.join(WEB, page));
  const iStyle = html.indexOf('href="/style.css?v=__V__"');
  const iDesign = html.indexOf('href="/design.css?v=__V__"');
  if (iStyle === -1 || iDesign === -1 || iDesign < iStyle) {
    errors.push(`${page}: design.css doit etre charge apres style.css et versionne (?v=__V__)`);
  }
  if (!html.includes('src="/polish.js?v=__V__"')) errors.push(`${page}: polish.js non charge`);
}
for (const contrat of ['dx-spot', 'dx-scrolled', '--dx-x']) {
  if (!polish.includes(contrat)) errors.push(`polish.js: contrat casse (${contrat} attendu)`);
}
if (!/prefers-reduced-motion/.test(polish)) errors.push('polish.js: doit rester coupe sous prefers-reduced-motion');
if (/\beval\s*\(|new Function\s*\(|document\.write/.test(polish)) {
  errors.push('polish.js: construction interdite par la CSP (eval / new Function / document.write)');
}

// ---------- rapport ----------
for (const w of warnings) console.warn(`⚠️  ${w}`);
if (errors.length) {
  console.error(`\n❌ check-design: ${errors.length} probleme(s):`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}
console.log(
  `✅ check-design: ${pages.length} pages · direction v3 respectee (violet sur noir, ` +
    `${ANIM_AUTORISEES.length} animations autorisees, ${utilises.length} jetons, ${blurs.length} flous <= 14px)`
);
