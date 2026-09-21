#!/usr/bin/env node
/* ============================================================================
   watchdog.js — surveillance EXTERNE du site.

   POURQUOI EXTERNE
   Le site s'alerte deja lui-meme (erreurs serveur, base injoignable via
   services/alerts.js), mais il ne peut pas signaler qu'il est INJOIGNABLE:
   quand le processus est mort, personne n'appelle Discord. Il faut donc un
   controleur exterieur.

   Ce script sert aux deux usages, sans compte a creer:
     - tache planifiee locale (Windows) -> fonctionne immediatement;
     - GitHub Actions -> fonctionne meme quand le PC est eteint.
   Il alerte par le webhook Discord deja configure, avec anti-repetition: une
   seule alerte par incident et par heure.

   Volontairement sans requete SQL lourde: /ping ne touche pas la base (voir
   README, quota Neon), et --deep ajoute /healthz pour la verifier aussi.

   Usage:
     node scripts/watchdog.js [--url https://site] [--deep] [--no-send] [--timeout 15]
   Code de sortie: 0 si le site repond, 1 sinon (exploitable par la CI).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

// dotenv est optionnel: la surveillance doit fonctionner meme si les
// dependances sont cassees (c'est justement le moment ou on en a besoin).
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  /* pas de .env: on se fie a l'environnement */
}
const { notifyDiscord } = require('../src/services/notify');

const args = process.argv.slice(2);
const lireArg = (nom, defaut) => {
  const i = args.indexOf(nom);
  return i !== -1 && args[i + 1] ? args[i + 1] : defaut;
};
const URL_BASE = (lireArg('--url', process.env.PUBLIC_URL || '')).replace(/\/$/, '');
const PROFOND = args.includes('--deep');
const ENVOYER = !args.includes('--no-send');
const TIMEOUT = Number(lireArg('--timeout', '15')) * 1000;

// Etat persistant: evite de repeter la meme alerte toutes les 15 minutes.
const RACINE = path.join(__dirname, '..', '..', '..', 'keysystem-backups');
const FICHIER_ETAT = path.join(RACINE, 'watchdog-state.json');
const FENETRE_MS = 60 * 60 * 1000;

if (!URL_BASE) {
  console.error('[watchdog] aucune URL (--url ou PUBLIC_URL). Surveillance impossible.');
  process.exit(2);
}

function lireEtat() {
  try {
    return JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf8'));
  } catch {
    return {};
  }
}
function ecrireEtat(etat) {
  try {
    fs.mkdirSync(RACINE, { recursive: true });
    fs.writeFileSync(FICHIER_ETAT, JSON.stringify(etat, null, 2));
  } catch {
    /* l'etat est un confort: un disque non inscriptible ne doit pas faire echouer la surveillance */
  }
}

async function sonde(chemin) {
  const url = URL_BASE + chemin;
  const debut = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' });
    const corps = await res.text().catch(() => '');
    return { url, ok: res.ok, code: res.status, ms: Date.now() - debut, corps: corps.slice(0, 300) };
  } catch (e) {
    return { url, ok: false, code: 0, ms: Date.now() - debut, erreur: e.message };
  }
}

(async () => {
  const cibles = ['/ping'];
  if (PROFOND) cibles.push('/healthz');
  const resultats = [];
  for (const chemin of cibles) {
    // Une seule relance: un hoquet reseau ne doit pas declencher une fausse alerte.
    let r = await sonde(chemin);
    if (!r.ok) {
      await new Promise((s) => setTimeout(s, 3000));
      r = await sonde(chemin);
    }
    resultats.push(r);
    console.log(
      `[watchdog] ${r.url} -> ${r.ok ? 'OK' : 'ECHEC'} (HTTP ${r.code}, ${r.ms} ms)${
        r.erreur ? ' ' + r.erreur : ''
      }`
    );
  }

  const enPanne = resultats.filter((r) => !r.ok);
  const etat = lireEtat();
  const maintenant = Date.now();

  // Journal de surveillance: une ligne par execution. Sans trace, une tache
  // planifiee "qui tourne" est une croyance, pas un fait.
  const journaliser = (verdict) => {
    try {
      fs.mkdirSync(RACINE, { recursive: true });
      fs.appendFileSync(
        path.join(RACINE, 'watchdog.log'),
        `${new Date().toISOString()} · ${verdict} · ${resultats.map((r) => `${r.code}:${r.ms}ms`).join(' ')}\n`
      );
    } catch {
      /* le journal ne doit jamais faire echouer la surveillance */
    }
  };

  if (!enPanne.length) {
    // Retour a la normale apres un incident: on previent, sinon on ne sait pas
    // si la panne signalee plus tot est terminee.
    if (etat.incident && maintenant - (etat.derniereAlerte || 0) > 0) {
      console.log('[watchdog] le site repond de nouveau: fin de l incident.');
      if (ENVOYER) {
        await notifyDiscord({
          title: '✅ Site de nouveau disponible',
          color: 'key',
          description: `Les sondes repondent a nouveau (${resultats.map((r) => r.ms + ' ms').join(', ')}).`,
        });
      }
      etat.incident = false;
      etat.derniereAlerte = maintenant;
      ecrireEtat(etat);
    }
    console.log('[watchdog] VERDICT: site disponible');
    journaliser('disponible');
    return;
  }

  const dejaSignale = etat.incident && maintenant - (etat.derniereAlerte || 0) < FENETRE_MS;
  if (dejaSignale) {
    console.log(`[watchdog] panne deja signalee il y a ${Math.round((maintenant - etat.derniereAlerte) / 60000)} min`);
  } else if (ENVOYER) {
    await notifyDiscord({
      title: '🔴 Site INJOIGNABLE',
      color: 'ddos',
      description: enPanne
        .map((r) => `\`${r.url}\` -> ${r.erreur || 'HTTP ' + r.code} (${r.ms} ms)`)
        .join('\n')
        .slice(0, 1500),
      fields: [
        { name: 'Que faire ?', value: 'Render (badge du service), puis /healthz?deep=1 pour savoir si c est le site ou la base.' },
      ],
    });
    etat.incident = true;
    etat.derniereAlerte = maintenant;
    ecrireEtat(etat);
  }

  console.error(`[watchdog] VERDICT: ${enPanne.length} sonde(s) en echec`);
  journaliser(`PANNE (${enPanne.map((r) => r.url).join(', ')})`);
  process.exit(1);
})().catch((e) => {
  console.error('[watchdog] erreur inattendue:', e.message);
  process.exit(1);
});
