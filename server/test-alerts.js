#!/usr/bin/env node
/* ============================================================================
   test-alerts.js — anti-inondation des alertes d'erreurs.

   Une alerte par signature et par fenetre, un plafond global, rien hors
   production, et une notification Discord en echec ne doit jamais faire echouer
   le traitement de l'erreur d'origine. Ces regles evitent le pire des deux
   mondes: un canal muet (on ne voit pas la panne) ou un canal noye (on ne lit
   plus les alertes).
   ========================================================================== */
'use strict';
const { createReporter, signature } = require('./src/services/alerts');

const results = [];
function check(label, cond, detail) {
  results.push({ label, cond });
  console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail !== undefined ? ` — ${detail}` : ''}`);
}

(async () => {
  const envoyees = [];
  let t = 1_000_000;
  const r = createReporter({ send: async (m) => envoyees.push(m), now: () => t, actif: true });

  console.log('\n[1] Anti-inondation');
  await r.report(new Error('boom'), { where: 'test' });
  check('1re erreur envoyee', envoyees.length === 1, `envois=${envoyees.length}`);

  await r.report(new Error('boom'), { where: 'test' });
  check('meme erreur non renvoyee dans la fenetre', envoyees.length === 1, `envois=${envoyees.length}`);
  check('le regroupement est compte', r.stats.regroupees === 1, `regroupees=${r.stats.regroupees}`);

  await r.report(new Error('tout autre bug'), { where: 'test' });
  check('plafond global: 1 alerte par minute maximum', envoyees.length === 1, `envois=${envoyees.length}`);

  t += 61_000;
  await r.report(new Error('tout autre bug'), { where: 'test' });
  check('nouveau bug different envoye apres le plafond', envoyees.length === 2, `envois=${envoyees.length}`);

  t += 10 * 60 * 1000;
  await r.report(new Error('boom'), { where: 'test' });
  check('le meme bug est re-signale apres la fenetre', envoyees.length === 3, `envois=${envoyees.length}`);

  console.log('\n[2] Garde-fous de securite');
  const dev = createReporter({ send: async () => { throw new Error('ne doit jamais partir'); }, now: () => t, actif: false });
  await dev.report(new Error('bug local'), {});
  check('hors production: aucune alerte envoyee', dev.stats.ignoreesHorsProd === 1);

  const ko = createReporter({ send: async () => { throw new Error('Discord injoignable'); }, now: () => t, actif: true });
  let plante = false;
  try {
    await ko.report(new Error('peu importe'), {});
  } catch {
    plante = true;
  }
  check('un envoi Discord en echec ne fait pas planter report()', !plante);

  console.log('\n[3] Signature des erreurs');
  const e1 = new Error('meme bug');
  e1.stack = 'Error: meme bug\n    at chargerUtilisateur (/app/src/routes/api.js:42:7)';
  const e2 = new Error('meme bug');
  e2.stack = 'Error: meme bug\n    at chargerUtilisateur (/app/src/routes/api.js:42:7)';
  check('meme bug = meme signature', signature(e1) === signature(e2));
  check('signature liee au lieu du bug', signature(e1).includes('api.js:42:7'), signature(e1));
  check('bugs differents = signatures differentes', signature(e1) !== signature(new Error('autre bug')));

  const failed = results.filter((x) => !x.cond);
  console.log(`\n${results.length - failed.length}/${results.length} verifications OK`);
  if (failed.length) {
    console.error(`ECHEC: ${failed.map((f) => f.label).join(' | ')}`);
    process.exit(1);
  }
  console.log('✅ Alertes: anti-inondation conforme (une panne alerte, une tempete ne noie pas le canal).');
})().catch((e) => {
  console.error('ECHEC du test:', e.message);
  process.exit(1);
});
