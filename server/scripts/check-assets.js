#!/usr/bin/env node
// ============================================================================
// check-assets.js — garde-fou qualite (utilise par la CI et en local).
// ----------------------------------------------------------------------------
// Verifie, sans base de donnees, les regressions qui cassent silencieusement le
// site en production:
//   1. tout asset reference par une page existe vraiment (plus de 404 CSS/JS);
//   2. syntaxe JS valide partout (front + back);
//   3. plus AUCUN <script> inline dans les pages (sinon la CSP sans
//      'unsafe-inline' bloquerait le script en production);
//   4. les pages HTML referencent bien la version d'assets (?v=__V__);
//   5. aucun attribut de gestion d'evenement n'interpole de donnee serveur
//      (vecteur d'injection: on lit les valeurs via data-* uniquement);
//   6. les polices auto-hebergees existent (sinon le site tombe en police systeme).
//
// Usage: node scripts/check-assets.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const SRV = path.join(__dirname, '..', 'src');

const errors = [];
const warnings = [];

function walk(dir, filter, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, filter, acc);
    } else if (filter(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------- 1. assets references ----------
const htmlFiles = walk(WEB, (n) => n.endsWith('.html'));
const refRe = /(?:src|href)="(\/(?!\/)[^"]+)"/g;

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(refRe)) {
    const url = match[1].split('?')[0].split('#')[0];
    if (url.startsWith('/api/') || url === '/' || url === '') continue;
    // Routes de pages servies dynamiquement par le middleware HTML
    // (/getkey, /admin/, /privacy/...): on retire le slash final avant le test.
    const clean = url.replace(/\/+$/, '');
    const candidate = clean === '' ? path.join(WEB, 'index.html') : path.join(WEB, clean);
    if (!fs.existsSync(candidate) && !fs.existsSync(`${candidate}.html`)) {
      errors.push(`${path.basename(file)}: asset manquant -> ${url}`);
    }
  }
}

// ---------- 2. syntaxe JS ----------
const jsFiles = [
  ...walk(WEB, (n) => n.endsWith('.js')),
  ...walk(SRV, (n) => n.endsWith('.js')),
  ...walk(path.join(__dirname), (n) => n.endsWith('.js')),
];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    errors.push(`syntaxe invalide: ${path.relative(ROOT, file)}\n${e.stderr?.toString().slice(0, 300)}`);
  }
}

// ---------- 3. scripts inline ----------
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(SCRIPT_RE)) {
    const [, attrs, body] = match;
    if (/src=/i.test(attrs)) continue;
    if (/ld\+json/i.test(attrs)) continue;
    if (body.trim()) errors.push(`${path.basename(file)}: <script> inline restant (bloque par la CSP)`);
  }
}

// ---------- 4. versionnement des assets ----------
const VERSIONED_ASSET_RE =
  /(?:src|href)="(\/(?:style\.css|design\.css|effects\.js|guard\.js|polish\.js|cookie-consent\.js|site-config\.js|ad-init\.js|app-[a-z]+\.js|favicon\.[a-z]+))"/g;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(VERSIONED_ASSET_RE)) {
    errors.push(`${path.basename(file)}: reference sans ?v=__V__ -> ${match[1]}`);
  }
}

// ---------- 5. donnees serveur dans les gestionnaires d'evenements ----------
const HANDLER_RE = /\bon(click|error|input|change|submit|load)\s*=\s*\\?"([^"]*)\\?"/g;
for (const file of jsFiles.filter((f) => f.includes(`${path.sep}web${path.sep}`))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const match of src.matchAll(HANDLER_RE)) {
    const handler = match[2];
    const interpolations = [...handler.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
    for (const expr of interpolations) {
      // Autorise: identifiants numeriques (id/version/placeId/user_id) et esc(...)
      const safe =
        /esc\(/.test(expr) ||
        /^(k|b|g|v|p|s|r|i|item)?\.?(id|version|placeId|place_id|user_id|member_count)$/.test(expr) ||
        /^[a-z_]+(_id|Id)$/.test(expr) ||
        /^(ads|expired|count|total|index|i|n)$/.test(expr);
      if (!safe) {
        errors.push(
          `${path.basename(file)}: donnee non echappee dans un attribut ${match[1]} -> ${expr} (utiliser data-* + this.dataset)`
        );
      }
    }
  }
}

// ---------- 6. polices ----------
const fontsDir = path.join(WEB, 'fonts');
if (!fs.existsSync(fontsDir) || !fs.readdirSync(fontsDir).some((f) => f.endsWith('.woff2'))) {
  errors.push('web/fonts/: aucune police auto-hebergee (lancer node scripts/selfhost-fonts.py)');
}
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
for (const match of css.matchAll(/url\('\/fonts\/([^']+)'\)/g)) {
  if (!fs.existsSync(path.join(fontsDir, match[1]))) {
    errors.push(`style.css reference une police absente: /fonts/${match[1]}`);
  }
}
if (/@import\s+url\(['"]?https:\/\/fonts\.googleapis/.test(css)) {
  errors.push('style.css: @import Google Fonts encore present (RGPD + chaine bloquante)');
}
if (!fs.existsSync(path.join(WEB, 'og.png'))) warnings.push('web/og.png manquant (image de partage social)');
if (!fs.existsSync(path.join(WEB, 'robots.txt'))) warnings.push('web/robots.txt manquant');
if (!fs.existsSync(path.join(WEB, 'sitemap.xml'))) warnings.push('web/sitemap.xml manquant');

// ---------- rapport ----------
for (const w of warnings) console.warn(`⚠️  ${w}`);
if (errors.length) {
  console.error(`\n❌ ${errors.length} probleme(s):`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}
console.log(
  `✅ check-assets: ${htmlFiles.length} pages, ${jsFiles.length} fichiers JS, ` +
    `${jsFiles.length} syntaxes verifiees, aucun asset manquant, aucun script inline.`
);
