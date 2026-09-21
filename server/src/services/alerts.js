// Alertes d'erreurs serveur -> Discord, avec anti-inondation.
//
// POURQUOI CE CHOIX: sur le plan gratuit Neon, surveiller la base en l'interrogeant
// consomme le quota (chaque reveil coute ~5 min de calcul a 0,25 CU). Alerter sur
// EVENEMENT (une erreur se produit) au lieu de sonder en boucle ne coute rien
// quand tout va bien et detecte la panne en quelques secondes quand ca casse.
//
// Regles: une erreur est TOUJOURS ecrite dans les logs; Discord recoit au plus
// une alerte par signature et par FENETRE_MS, jamais plus d'une par PLAFOND_MS
// (toutes signatures confondues), et uniquement en production.

const { notifyDiscord } = require('./notify');

const FENETRE_MS = 10 * 60 * 1000; // meme erreur: 1 alerte / 10 min
const PLAFOND_MS = 60 * 1000; // toutes erreurs: 1 alerte / minute
const MAX_SIGNATURES = 200; // borne memoire (purge si depassee)

// Signature stable d'une erreur: message + fichier d'origine. Deux occurrences du
// meme bug se regroupent; deux bugs differents restent distincts.
function signature(err) {
  const message = String((err && (err.message || err)) || 'unknown').slice(0, 160);
  const frame = String((err && err.stack) || '')
    .split('\n')
    .find((l) => l.includes(' at ') && !l.includes('node:'));
  const lieu = (frame || '').match(/([^()\s\\/]+:\d+:\d+)\)?\s*$/) || [];
  return `${message}|${lieu[1] || ''}`;
}

function createReporter({ send = notifyDiscord, now = Date.now, actif = process.env.NODE_ENV === 'production' } = {}) {
  const vues = new Map();
  let dernierEnvoi = 0;
  const stats = { envoyees: 0, regroupees: 0, ignoreesHorsProd: 0 };

  async function report(err, contexte = {}) {
    const message = String((err && (err.message || err)) || 'unknown').slice(0, 400);
    // Toujours visible dans les logs Render, quoi qu'il arrive.
    console.error(`[alerte${contexte.where ? ':' + contexte.where : ''}]`, message);

    if (!actif) {
      stats.ignoreesHorsProd++;
      return false;
    }
    const sig = signature(err);
    const t = now();
    const vue = vues.get(sig);
    if (vue && t - vue.at < FENETRE_MS) {
      vue.n++;
      stats.regroupees++;
      return false;
    }
    if (t - dernierEnvoi < PLAFOND_MS) {
      stats.regroupees++;
      return false;
    }
    if (vues.size >= MAX_SIGNATURES) vues.clear();
    vues.set(sig, { at: t, n: 1 });
    dernierEnvoi = t;
    stats.envoyees++;

    await send({
      title: '🚨 Server error',
      color: 'ddos',
      description: `\`\`\`\n${message}\n\`\`\``,
      fields: [
        { name: 'Origin', value: contexte.where || 'unknown' },
        { name: 'Route', value: contexte.route || '—' },
        { name: 'Runtime', value: `${process.version} · ${process.env.NODE_ENV || 'dev'}` },
      ],
    }).catch(() => {});
    return true;
  }

  function install() {
    process.on('unhandledRejection', (raison) => {
      report(raison, { where: 'unhandledRejection' });
    });
    // On journalise et on continue: un serveur de cles qui tombe coute plus cher
    // qu'un process au contexte incertain (Render redemarre de toute facon).
    process.on('uncaughtException', (err) => {
      report(err, { where: 'uncaughtException' });
    });
  }

  return { report, install, stats };
}

// Instance utilisee par le serveur.
const defaut = createReporter();

module.exports = { createReporter, signature, report: defaut.report, install: defaut.install, stats: defaut.stats };
