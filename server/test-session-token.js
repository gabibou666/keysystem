/* Verifie le point de controle de session /api/v1/token (anti-dump).
   Le serveur est demarre par ce test lui-meme, sur un port dedie.
   Sans DATABASE_URL (integration continue), le test s'annonce et se saute.
   Regle de fond: ce test n'affiche JAMAIS la cle ni le jeton. */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const RACINE = __dirname;
require(path.join(RACINE, 'node_modules', 'dotenv')).config({ path: path.join(RACINE, '.env') });

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
let echecs = 0;
function verifie(intitule, condition, detail) {
  console.log(`${condition ? '  OK  ' : '  ECHEC'} ${intitule}${detail ? ' -> ' + detail : ''}`);
  if (!condition) echecs++;
}
const post = async (corps) => {
  const r = await fetch(`${BASE}/api/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corps),
  });
  return { status: r.status, corps: await r.json().catch(() => ({})) };
};
const attendre = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`${BASE}/ping`);
      if (r.ok) return true;
    } catch (_) { /* pas encore pret */ }
  }
  return false;
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  (saute: DATABASE_URL absent de cet environnement)');
    process.exit(0);
  }
  const { Client } = require(path.join(RACINE, 'node_modules', 'pg'));
  const { sslOptions, urlSansSslmode } = require(path.join(RACINE, 'src', 'db-ssl'));
  const crypto = require(path.join(RACINE, 'src', 'services', 'crypto'));

  const c = new Client({
    connectionString: urlSansSslmode(process.env.DATABASE_URL),
    ssl: sslOptions(process.env.DATABASE_URL),
  });
  await c.connect();
  const { rows } = await c.query(
    `SELECT kid, signature, bound_user_id FROM keys
      WHERE NOT revoked AND expires_at > now() AND bound_user_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`
  );
  await c.end();
  if (!rows.length) {
    console.log('  (saute: aucune cle liee et valide en base pour ce test)');
    process.exit(0);
  }
  const { kid, signature, bound_user_id } = rows[0];
  const bonUserId = String(bound_user_id);
  const candidats = [`${kid}.${signature}`, `${kid}-${signature}`, `${kid}${signature}`, `KS-${kid}-${signature}`];
  const cle = candidats.find((x) => crypto.verifyKeyFormat(x));
  if (!cle) { console.error('  ECHEC: format de cle non reconnu'); process.exit(1); }

  const serveur = spawn(process.execPath, ['src/index.js'], {
    cwd: RACINE,
    env: { ...process.env, PORT: String(PORT), SCHEDULERS: 'off', PUBLIC_URL: '' },
    stdio: 'ignore',
  });
  const arret = () => { try { serveur.kill(); } catch (_) { /* deja mort */ } };
  process.on('exit', arret);

  if (!(await attendre())) { console.error('  ECHEC: le serveur n\'a pas repondu sur /ping'); arret(); process.exit(1); }

  const ok = await post({ key: cle, userId: bonUserId });
  verifie('cle valide + bon utilisateur -> 200', ok.status === 200, `HTTP ${ok.status} ${ok.corps.reason || ''}`);
  verifie('jeton renvoye', typeof ok.corps.token === 'string' && ok.corps.token.length > 40);
  verifie('duree de vie annoncee', ok.corps.expiresIn >= 60, `${ok.corps.expiresIn}s`);
  verifie('cadence de controle annoncee', ok.corps.intervalSec >= 30, `${ok.corps.intervalSec}s`);
  const ok2 = await post({ key: cle, userId: bonUserId });
  verifie('jeton unique a chaque appel (non rejouable)', ok2.corps.token !== ok.corps.token);

  const autre = String(Number(bonUserId) + 1);
  const partage = await post({ key: cle, userId: autre });
  verifie('refus d\'une cle partagee (autre utilisateur)',
    partage.status === 403 && partage.corps.reason === 'key_bound_to_other_user', `HTTP ${partage.status} ${partage.corps.reason || ''}`);

  const falsifiee = cle.slice(0, -1) + (cle.slice(-1) === 'a' ? 'b' : 'a');
  const f = await post({ key: falsifiee, userId: bonUserId });
  verifie('refus d\'une cle falsifiee', f.status === 401, `HTTP ${f.status} ${f.corps.reason || ''}`);
  const absent = await post({ userId: bonUserId });
  verifie('refus sans cle', absent.status === 401, `HTTP ${absent.status} ${absent.corps.reason || ''}`);
  const invalide = await post({ key: cle, userId: 'pas-un-id' });
  verifie('refus d\'un identifiant utilisateur invalide', invalide.status === 401, `HTTP ${invalide.status} ${invalide.corps.reason || ''}`);

  arret();
  console.log(`\n  VERDICT: ${echecs === 0 ? 'le point de controle de session se comporte comme prevu' : echecs + ' probleme(s)'}`);
  process.exit(echecs === 0 ? 0 : 1);
})().catch((e) => { console.error('  ECHEC:', e.message); process.exit(1); });
