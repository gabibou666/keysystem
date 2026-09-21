// ============================================================================
// Validation de configuration au demarrage — KeySystem
// ----------------------------------------------------------------------------
// Pourquoi ce fichier existe:
//   Avec les valeurs par defaut historiques, une variable d'environnement
//   oubliee en production donnait soit des cles FORGEABLES (HMAC_SECRET=
//   'dev-secret' est public et devinable), soit un AES_KEY ALEATOIRE par
//   processus => les builds chiffres devenaient ILLISIBLES apres chaque
//   redeploiement (perte silencieuse du script).
//
// Regle appliquee ici:
//   - production: on REFUSE de demarrer si un secret critique est absent ou
//     invalide (fail-fast, pas de degradation silencieuse de la securite) ;
//   - developpement: secret ephemere aleatoire (jamais 'dev-secret') + warning.
// ============================================================================

const nodeCrypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

// Secrets dont l'absence rend le service DANGEREUX (cles forgeables avec un
// secret public) ou totalement inoperant: on refuse de demarrer en production.
// Les autres variables ne provoquent qu'un avertissement: une variable oubliee
// ne doit jamais pouvoir mettre le site hors ligne.
const CRITICAL = ['DATABASE_URL', 'HMAC_SECRET'];

// Secrets importants mais non bloquants: absence = warning + alerte Discord.
const IMPORTANT = [
  'PUBLIC_URL',
  'AES_KEY',
  'LOOTLABS_API_KEY',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_WEBHOOK_URL',
];

const HEX64 = ['HMAC_SECRET', 'AES_KEY'];

// Commande a donner a l'utilisateur pour produire une valeur acceptee.
const GENERER_HEX64 = 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

// Decrit POURQUOI une valeur est refusee, sans jamais la divulguer: l'utilisateur
// qui vient de coller sa variable dans Render a besoin de savoir si le probleme
// est l'absence, la longueur ou le jeu de caracteres. Un message qui ne dit que
// "non defini" quand la variable EST definie envoie dans une boucle sans fin.
function decrireValeur(value) {
  if (!value) return 'absente';
  const estHex = /^[0-9a-f]+$/i.test(value);
  return `presente mais invalide: ${value.length} caracteres${estHex ? '' : ', avec des caracteres non hexadecimaux'}, 64 attendus`;
}

const ephemeral = new Map();

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// Renvoie un secret utilisable. En production, leve immediatement si absent.
function secret(name) {
  const value = process.env[name];
  const valid = HEX64.includes(name) ? isHex64(value) : !!value;
  if (valid) return value;

  if (IS_PROD) {
    throw new Error(
      `[config] ${name} ${value ? 'invalide (64 caracteres hex attendus)' : 'manquant'} — demarrage refuse en production`
    );
  }

  if (!ephemeral.has(name)) {
    ephemeral.set(name, nodeCrypto.randomBytes(32).toString('hex'));
    console.warn(
      `[config] ${name} non defini — secret ephemere genere pour ce process (DEV uniquement, change a chaque redemarrage)`
    );
  }
  return ephemeral.get(name);
}

// Cle AES-256 (32 octets) pour les originaux chiffres.
// Si AES_KEY n'est pas 64 caracteres hex, on en derive une cle DETERMINISTE
// (sha256): une valeur inattendue ne doit ni casser la lecture des originaux,
// ni surtout changer a chaque demarrage — l'ancien code tirait une cle ALEATOIRE
// quand le format etait inattendu, ce qui rendait les originaux illisibles apres
// chaque redeploiement.
function aesKey() {
  const value = process.env.AES_KEY;
  if (isHex64(value)) return Buffer.from(value, 'hex');
  const source = value || secret('AES_KEY');
  return nodeCrypto.createHash('sha256').update(`keysystem:aes:${source}`).digest();
}

// Verifie la configuration et journalise un rapport lisible.
// Retourne { critical: [], warnings: [] }.
function checkConfig() {
  const critical = [];
  const warnings = [];

  if (IS_PROD) {
    for (const key of CRITICAL) {
      if (!process.env[key]) critical.push(`${key} manquant`);
    }
    for (const key of IMPORTANT) {
      if (!process.env[key] && !HEX64.includes(key)) warnings.push(`${key} manquant`);
    }
    if (process.env.HMAC_SECRET && !isHex64(process.env.HMAC_SECRET)) {
      warnings.push(
        `HMAC_SECRET ${decrireValeur(process.env.HMAC_SECRET)}. Generer une valeur valide: ${GENERER_HEX64}`
      );
    }
    if (process.env.AES_KEY && !isHex64(process.env.AES_KEY)) {
      warnings.push(
        `AES_KEY ${decrireValeur(process.env.AES_KEY)}. Une cle derivee est utilisee (les originaux chiffres restent lisibles). Generer une valeur valide: ${GENERER_HEX64}`
      );
    }
    if (process.env.HMAC_SECRET && process.env.HMAC_SECRET === process.env.AES_KEY) {
      critical.push('HMAC_SECRET et AES_KEY doivent etre differents');
    }
    if (process.env.PUBLIC_URL && !process.env.PUBLIC_URL.startsWith('https://')) {
      warnings.push('PUBLIC_URL devrait etre en https en production');
    }
    if (!process.env.LOOTLABS_POSTBACK_SECRET) {
      warnings.push(
        'LOOTLABS_POSTBACK_SECRET absent: le postback ne peut pas etre authentifie par signature ' +
          '(anti-bypass affaibli). A recuperer dans le dashboard LootLabs, puis ajouter la variable dans Render.'
      );
    }
  }

  const label = IS_PROD ? 'production' : 'developpement';
  if (critical.length) {
    console.error(`[config] Configuration ${label} INVALIDE:\n  - ${critical.join('\n  - ')}`);
  }
  if (warnings.length) {
    console.warn(`[config] Recommandations ${label}:\n  - ${warnings.join('\n  - ')}`);
  }
  if (!critical.length && !warnings.length) {
    console.log(`[config] Configuration ${label} valide (${CRITICAL.length + IMPORTANT.length} variables verifiees)`);
  }
  return { critical, warnings };
}

// A appeler en tout premier dans index.js: stoppe le process si la
// configuration de production est dangereuse ou cassee.
function assertProdConfig() {
  const { critical, warnings } = checkConfig();
  if (critical.length && IS_PROD) {
    console.error('[config] Arret du serveur: corrigez les variables d\'environnement ci-dessus.');
    process.exit(1);
  }
  return { critical, warnings };
}

module.exports = { IS_PROD, CRITICAL, IMPORTANT, secret, aesKey, isHex64, checkConfig, assertProdConfig };
