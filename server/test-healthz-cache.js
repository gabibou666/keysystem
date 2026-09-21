#!/usr/bin/env node
/* ============================================================================
   test-healthz-cache.js — la sonde profonde ne doit PAS reveiller la base a
   chaque appel.

   Enjeu: le plan gratuit Neon met le calcul en veille apres 5 min d'inactivite
   et accorde 100 CU-hours/mois. Une requete SQL toutes les 5 min garde la base
   eveillee 24 h/24 (~182 CU-hours/mois) et epuise le quota: c'est ce qui est
   arrive avec le workflow keepalive qui visait /api/stats/public.

   Ce test demontre, en executant le vrai serveur:
     1. /ping et /api/keepalive repondent MEME quand la base est injoignable
        (donc ils ne la touchent pas) -> ce sont les cibles des moniteurs;
     2. /healthz met la sonde en cache (une seule requete SQL par heure);
     3. ?deep=1 force la sonde (diagnostic), et une base en panne n'est pas
        mise en cache une heure (reprise detectee en ~60 s).
   ========================================================================== */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const FAKE_DB = 'postgresql://user:pass@127.0.0.1:5432/absente';
const results = [];
function check(label, cond, detail) {
  results.push({ label, cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail !== undefined ? ` — ${detail}` : ''}`);
}

async function boot(env, port) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: __dirname,
    // NODE_ENV=test: les alertes d'erreurs sont inactives hors production, un
    // test ne doit jamais envoyer de notification Discord reelle.
    env: { ...process.env, PORT: String(port), SCHEDULERS: 'off', PUBLIC_URL: '', NODE_ENV: 'test', ...env },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`);
      if (r.ok) return child;
    } catch {
      /* pas encore pret */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`le serveur n'a pas repondu sur /ping (port ${port})`);
}

const get = async (port, route) => {
  const r = await fetch(`http://127.0.0.1:${port}${route}`);
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* reponse non JSON */
  }
  return { status: r.status, body };
};

(async () => {
  // ---------- Scenario 1: base injoignable ----------
  console.log('\n[1] Base injoignable — les sondes legeres doivent rester vertes');
  let child = await boot({ DATABASE_URL: FAKE_DB }, 3141);
  try {
    const ping = await get(3141, '/ping');
    check('/ping repond 200 sans base', ping.status === 200, `HTTP ${ping.status}`);

    const ka = await get(3141, '/api/keepalive');
    check('/api/keepalive repond 200 sans base', ka.status === 200, `HTTP ${ka.status}`);

    const h1 = await get(3141, '/healthz');
    check('/healthz signale la base en panne (503)', h1.status === 503 && h1.body.ok === false, `HTTP ${h1.status} ${JSON.stringify(h1.body)}`);
    check('1re sonde non mise en cache (cached:false)', h1.body.cached === false);

    const h2 = await get(3141, '/healthz');
    check('2e appel servi depuis le cache (cached:true)', h2.status === 503 && h2.body.cached === true, JSON.stringify(h2.body));
    check('panne non verrouillee 1 h (nouvelle sonde <= 60 s)', h2.body.nextDeepCheckInSec >= 0 && h2.body.nextDeepCheckInSec <= 60, `nextDeepCheckInSec=${h2.body.nextDeepCheckInSec}`);

    const h3 = await get(3141, '/healthz?deep=1');
    check('?deep=1 force une vraie sonde (cached:false)', h3.body.cached === false && h3.status === 503);
  } finally {
    child.kill();
  }

  // ---------- Scenario 2: base reelle ----------
  console.log('\n[2] Base reelle — la sonde profonde est mise en cache (quota gratuit)');
  child = await boot({}, 3142);
  try {
    const h1 = await get(3142, '/healthz');
    check('sonde profonde OK (db up)', h1.status === 200 && h1.body.db === 'up' && h1.body.cached === false, JSON.stringify(h1.body));
    check('latence mesuree', typeof h1.body.latencyMs === 'number');

    const h2 = await get(3142, '/healthz');
    check('2e appel NE touche PAS la base (cached:true)', h2.body.cached === true, JSON.stringify(h2.body));
    check('prochaine sonde dans ~6 h (delai par defaut, quota gratuit)', h2.body.nextDeepCheckInSec > 3500, `nextDeepCheckInSec=${h2.body.nextDeepCheckInSec}`);

    let cachedCount = 0;
    for (let i = 0; i < 20; i++) {
      const r = await get(3142, '/healthz');
      if (r.body.cached) cachedCount++;
    }
    check('20 appels consecutifs = 0 requete SQL supplementaire', cachedCount === 20, `${cachedCount}/20 servis par le cache`);
  } finally {
    child.kill();
  }

  const failed = results.filter((r) => !r.cond);
  console.log(`\n${results.length - failed.length}/${results.length} verifications OK`);
  if (failed.length) {
    console.error(`ECHEC: ${failed.map((f) => f.label).join(' | ')}`);
    process.exit(1);
  }
  console.log('✅ La base n\'est reveillee qu\'une fois par heure au maximum par la surveillance.');
})().catch((e) => {
  console.error('ECHEC du test:', e.message);
  process.exit(1);
});
