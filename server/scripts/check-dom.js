#!/usr/bin/env node
/* ============================================================================
   check-dom.js — aucun identifiant attendu par le JS ne doit manquer dans la page.

   POURQUOI
   Une reference morte (getElementById('x') alors que l'element n'existe plus)
   ne se contente pas d'echouer: elle LEVE une exception au premier appel et
   interrompt le reste du script de la page. Tout ce qui suit cesse de
   fonctionner — d'ou l'impression que des fonctionnalites "disparaissent" sans
   qu'aucune erreur ne soit visible pour l'utilisateur.

   Ce qui n'est PAS une erreur: un identifiant que le JS cree lui-meme
   (banniere de cookies, overlay anti-adblock, bait de detection...). Ces
   elements n'ont pas a figurer dans le HTML: le controle les reconnait.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');

// Page <-> script qui la pilote.
const PAIRES = [
  ['../server/views/admin.html', 'app-admin-dashboard.js'],
  ['index.html', 'app-index.js'],
  ['discord-bot.html', 'app-discord-bot.js'],
  ['moderation.html', 'app-moderation.js'],
  ['dashboard.html', 'app-dashboard.js'],
  ['dashboard.html', 'app-account.js'],
  ['dashboard.html', 'script-workspace.js'],
  ['docs.html', 'script-docs.js'],
  ['hubs.html', 'app-catalog.js'],
  ['signup.html', 'app-auth.js'],
  ['login.html', 'app-auth.js'],
  ['verify-email.html', 'app-auth.js'],
  ['reset-password.html', 'app-auth.js'],
  ['claim.html', 'app-claim.js'],
];

const problems = [];
let totalAttendus = 0;

for (const [page, script] of PAIRES) {
  const cheminPage = path.join(WEB, page);
  const cheminScript = path.join(WEB, script);
  if (!fs.existsSync(cheminPage) || !fs.existsSync(cheminScript)) continue;

  const html = fs.readFileSync(cheminPage, 'utf8');
  const code = fs.readFileSync(cheminScript, 'utf8');

  const idsDeLaPage = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  // Identifiants crees par le script: legitimement absents du HTML.
  const idsCrees = new Set();
  for (const m of code.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) idsCrees.add(m[1]);
  for (const m of code.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]/g)) idsCrees.add(m[1]);
  for (const m of code.matchAll(/\bid=["']([^"']+)["']/g)) idsCrees.add(m[1]);

  const attendus = new Set(
    [...code.matchAll(/(?:getElementById|\$)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  );
  totalAttendus += attendus.size;

  const manquants = [...attendus].filter((id) => !idsDeLaPage.has(id) && !idsCrees.has(id)).sort();
  if (manquants.length) {
    problems.push(`${page} <- ${script}: ${manquants.join(', ')}`);
  }
}

if (problems.length) {
  console.error(`❌ check-dom: ${problems.length} page(s) avec reference morte (getElementById sans element)`);
  problems.forEach((p) => console.error(`   • ${p}`));
  console.error('   Une reference morte interrompt le script de la page : le reste cesse de fonctionner.');
  process.exit(1);
}
console.log(
  `✅ check-dom: ${totalAttendus} identifiants attendus par le JS, tous presents dans leur page (ou crees dynamiquement).`
);
