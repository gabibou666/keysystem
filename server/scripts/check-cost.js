#!/usr/bin/env node
/* ============================================================================
   check-cost.js — garde-fou de CONSOMMATION (base de donnees gratuite).

   POURQUOI CE CONTROLE EXISTE
   Le plan gratuit Neon offre 100 CU-hours/mois par projet et met le calcul en
   veille apres 5 minutes d'inactivite. Donc UNE seule requete SQL toutes les
   5 minutes suffit a garder la base eveillee 24 h/24, soit ~182 CU-hours/mois
   (730 h x 0,25 CU) : le quota est epuise vers le 16 du mois et la base est
   suspendue jusqu'a la periode suivante. C'est exactement ce qui est arrive:
   le workflow keepalive visait /api/stats/public, une route qui fait un SELECT.

   Ce fichier rend la regle executable. Il echoue si une modification remet le
   piege en place. Sans lui, la correction serait une intention, pas un etat.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server', 'src');

// Routes qui ne touchent JAMAIS la base: ce sont les seules cibles autorisees
// pour un ping frequent (moniteur, keep-alive, self-ping).
const DB_FREE_ROUTES = ['/ping', '/api/keepalive'];
// En dessous de ce seuil, une requete SQL periodique empeche Neon de dormir.
const DORMANCY_MS = 5 * 60 * 1000;

const problems = [];
const warnings = [];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ---------- 1. Aucun workflow GitHub ne doit viser une route qui lit la base ----------
const wfDir = path.join(ROOT, '.github', 'workflows');
if (fs.existsSync(wfDir)) {
  for (const file of fs.readdirSync(wfDir)) {
    const src = fs.readFileSync(path.join(wfDir, file), 'utf8');
    for (const m of src.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      const url = m[0];
      const host = (url.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
      // Un ping vers localhost (smoke test CI) ne consomme rien chez Neon.
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) continue;
      const route = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (!route || route === '/') continue;
      const sansBase = DB_FREE_ROUTES.some((r) => route === r);
      const toucheLaBase = route.startsWith('/api/') || route.startsWith('/healthz');
      if (toucheLaBase && !sansBase) {
        problems.push(
          `${file}: ping vers ${route} qui interroge la base -> reveille Neon 24 h/24 ` +
            `(~182 CU-hours/mois pour 100 disponibles). Utiliser ${DB_FREE_ROUTES.join(' ou ')}.`
        );
      }
    }
  }
}

// ---------- 2. Le self-ping interne doit viser une route sans base ----------
const indexPath = path.join(SERVER, 'index.js');
const indexSrc = fs.readFileSync(indexPath, 'utf8');
if (/SELF_PING_URL/.test(indexSrc) && !/SELF_PING_URL[\s\S]{0,200}(api\/keepalive|\/ping)/.test(indexSrc)) {
  problems.push('index.js: le self-ping doit viser une route sans base (/api/keepalive ou /ping).');
}

// ---------- 3. Les routes declarees "sans base" ne doivent pas appeler le pool ----------
for (const route of DB_FREE_ROUTES) {
  const at = indexSrc.indexOf(`app.get('${route}'`);
  if (at === -1) {
    warnings.push(`index.js: route sans base ${route} introuvable (renommee ou supprimee ?)`);
    continue;
  }
  // Fenetre courte = le corps de la route (declaration en une ligne). 260
  // caracteres suffisent et evitent de mordre sur la route suivante.
  if (/pool\.query|db\.query/.test(indexSrc.slice(at, at + 260))) {
    problems.push(`index.js: la route ${route} est censee ignorer la base mais appelle le pool.`);
  }
}

// ---------- 4. /healthz doit garder son delai anti-reveil ----------
if (!/HEALTHZ_DEEP_TTL_MIN/.test(indexSrc)) {
  problems.push("index.js: /healthz doit garder son delai anti-reveil (HEALTHZ_DEEP_TTL_MIN).");
}
if (!/cached/.test(indexSrc)) {
  problems.push("index.js: /healthz doit pouvoir repondre depuis son cache (champ 'cached') pour ne pas reveiller la base a chaque appel.");
}
if (!/query\.deep/.test(indexSrc)) {
  problems.push("index.js: /healthz doit conserver la sonde forcee ?deep=1 (diagnostic ponctuel).");
}

// ---------- 5. Aucune requete SQL periodique plus frequente que la veille Neon ----------
for (const file of walk(SERVER)) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  for (const m of src.matchAll(/setInterval\s*\(([\s\S]{0,700}?)\)\s*(?:\.unref\(\))?\s*;/g)) {
    const body = m[1];
    const periods = [...body.matchAll(/(\d+)\s*\*\s*60\s*\*\s*1000|(\d+)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/g)];
    const toucheLaBase = /pool\.query|db\.query/.test(body);
    if (!toucheLaBase) continue;
    const last = [...body.matchAll(/([\d_* ]+)\s*\*\s*1000/g)].pop();
    if (!last) continue;
    if (/\*\s*60\s*\*\s*60/.test(last[1])) continue; // >= 1 h : acceptable
    const minutes = Number((last[1].match(/(\d+)\s*\*\s*60\s*$/) || [])[1] || 0);
    if (minutes && minutes * 60 * 1000 < DORMANCY_MS) {
      problems.push(`${rel}: setInterval de ${minutes} min avec requete SQL -> empeche Neon de dormir (seuil ${DORMANCY_MS / 60000} min).`);
    }
  }
}

// ---------- Verdict ----------
if (warnings.length) warnings.forEach((w) => console.warn(`⚠️  check-cost: ${w}`));
if (problems.length) {
  console.error(`❌ check-cost: ${problems.length} probleme(s) de consommation`);
  problems.forEach((p) => console.error(`   • ${p}`));
  process.exit(1);
}
console.log('✅ check-cost: aucun ping ne reveille la base en boucle (quota Neon gratuit preserve).');
