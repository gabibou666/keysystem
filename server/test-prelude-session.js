/* Verifie le bloc de controle de session ajoute au preambule de CHAQUE build:
   1) il est present quand une adresse publique est fournie, absent en developpement;
   2) la validation structurelle du pipeline passe encore sur les VRAIS scripts
      (c'est le garde-fou qui empeche de servir un script casse);
   3) le bloc Luau est syntaxiquement valide (si un interpreteur Lua est present);
   4) le cas "copie extraite": sans cle, le bloc est bien present et arme.
   Sans DATABASE_URL (integration continue), les parties 2 et 4 sont sautees. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RACINE = __dirname;
require(path.join(RACINE, 'node_modules', 'dotenv')).config({ path: path.join(RACINE, '.env') });

const { buildPrelude } = require('./src/compat/prelude');
const { obfuscate, validateStructure } = require('./src/compat/obfuscator');

const SITE = 'https://keysystem-vv8b.onrender.com';
let echecs = 0;
function verifie(intitule, condition, detail) {
  console.log(`${condition ? '  OK  ' : '  ECHEC'} ${intitule}${detail ? ' -> ' + detail : ''}`);
  if (!condition) echecs++;
}

// --- 1) Presence / absence du bloc -----------------------------------------
const avec = buildPrelude({ siteUrl: SITE });
const sans = buildPrelude({ siteUrl: '' });
const decode = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
verifie('bloc present quand l\'adresse publique est fournie', avec.includes('CONTROLE DE SESSION'));
verifie('adresse publique injectee', avec.includes(JSON.stringify(SITE)));
verifie('chemin du point de controle present', avec.includes('"/api/v1/token"'));
verifie('regle de tolerance documentee dans le code livre', avec.includes('absence de reponse (reseau, panne passagere) est toleree'));
verifie('neutralisation basee sur le differentiel de globales', avec.includes('__KS_AVANT'));
verifie('aucun bloc en developpement (adresse vide)', !sans.includes('CONTROLE DE SESSION') && !sans.includes('/api/v1/token'));
verifie('le corps du script reste precede du preambule', avec.startsWith('-- [compat prelude]'));

// --- 3) Syntaxe du bloc Luau -------------------------------------------------
// Enjeu reel: une faute de syntaxe ici casserait le script de TOUS les
// utilisateurs, et la validation structurelle du pipeline ne l'attraperait pas
// (elle compare des squelettes, ce n'est pas un analyseur Lua).
const blocLuau = buildPrelude({ siteUrl: SITE }).split('local __EXEC_NAME')[0];
let luaparse = null;
try { luaparse = require('luaparse'); } catch (_) { luaparse = null; }
verifie('analyseur Lua disponible (luaparse, devDependency)', !!luaparse,
  luaparse ? 'present' : 'absent: lancer npm install');
if (luaparse) {
  let valide = true;
  let detail = `${blocLuau.split('\n').length} lignes`;
  try {
    luaparse.parse(blocLuau, { luaVersion: '5.1' });
  } catch (e) {
    valide = false;
    detail = e.message;
  }
  verifie('le bloc Luau compile', valide, detail);
  // Controle negatif: sans lui, un analyseur factice passerait ce test.
  let detecte = false;
  try { luaparse.parse(blocLuau + '\nif true then', { luaVersion: '5.1' }); } catch (_) { detecte = true; }
  verifie('une faute de syntaxe volontaire est bien detectee', detecte);
}

// --- 2) + 4) Validation structurelle sur les vrais scripts ------------------
if (!process.env.DATABASE_URL) {
  console.log('  (saute: DATABASE_URL absent de cet environnement)');
} else {
  const { Client } = require(path.join(RACINE, 'node_modules', 'pg'));
  const { sslOptions, urlSansSslmode } = require(path.join(RACINE, 'src', 'db-ssl'));
  const { decryptAES } = require(path.join(RACINE, 'src', 'services', 'crypto'));
  (async () => {
    const c = new Client({
      connectionString: urlSansSslmode(process.env.DATABASE_URL),
      ssl: sslOptions(process.env.DATABASE_URL),
    });
    await c.connect();
    const { rows } = await c.query(
      'SELECT version, original_enc, original_iv FROM script_versions WHERE original_enc IS NOT NULL ORDER BY version'
    );
    await c.end();
    for (const r of rows) {
      const corps = decryptAES(r.original_enc, r.original_iv);
      const plein = buildPrelude({ siteUrl: SITE }) + corps;
      const build = obfuscate(plein);
      const check = validateStructure(plein, build);
      verifie(`v${r.version}: validation structurelle du build`, check.ok === true,
        check.ok ? `${build.length} octets livres` : JSON.stringify(check).slice(0, 160));
      // Le controle doit SURVIVRE a l'obfuscation: les identifiants restent
      // lisibles et le chemin du point de controle s'y retrouve une fois les
      // chaines encodees redecodees (c'est ce que fera l'executeur a l'execution).
      const contenu = decode(build);
      verifie(`v${r.version}: la neutralisation survit a l'obfuscation`, build.includes('__KS_AVANT') && build.includes('__KS_NEUTRALISER'));
      verifie(`v${r.version}: le point de controle survit a l'obfuscation`, contenu.includes('/api/v1/token'));
    }
    console.log(`\n  VERDICT: ${echecs === 0 ? 'le controle de session s\'ajoute sans casser les builds' : echecs + ' probleme(s)'}`);
    process.exit(echecs === 0 ? 0 : 1);
  })().catch((e) => { console.error('  ECHEC:', e.message); process.exit(1); });
}
