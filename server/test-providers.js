/* Verifie le CHOIX DE LA REGIE PUBLICITAIRE et le PALIER (nombre de publicites)
   ainsi que la duree de la cle delivree pour chaque combinaison:
     - LootLabs 1 pub  -> cle de 12 h (non-regression du chemin le plus utilise);
     - LootLabs 2 pubs -> cle de 24 h, delivree SEULEMENT apres 2 postbacks
       distincts (un seul postback ne doit JAMAIS delivrer la cle);
     - Work.ink 1 pub  -> cle de 24 h.
   Les refus sont couverts aussi: offre inconnue, palier indisponible
   (LOOTLABS_TIER2_ENABLED=false, Work.ink non configuree), postback qui ne
   correspond pas au palier grave dans la session, postback rejoue, token
   Work.ink invalide.
   Non-regression des sessions ANTERIEURES (ad_count NULL, creees avant la
   migration): elles doivent continuer a delivrer une cle de 12 h sans erreur.

   Le serveur est demarre par ce test lui-meme, sur des ports dedies (un second
   serveur, palier 2 pubs desactive, sert a prouver le refus cote HTTP). Les
   postbacks sont simules via HTTP local: AUCUN appel reseau a une regie, la
   verification du token Work.ink est servie par un stub local
   (WORKINK_VERIFY_URL).
   Sans DATABASE_URL (integration continue), le test s'annonce et se saute.

   Regle de fond: ce test n'affiche JAMAIS de secret (aucune valeur de .env, de
   cle ou de jeton) et nettoie ses lignes de test a la fin. */
'use strict';
const path = require('path');
const http = require('http');
const nodeCrypto = require('crypto');
const { spawn } = require('child_process');

const RACINE = __dirname;
require(path.join(RACINE, 'node_modules', 'dotenv')).config({ path: path.join(RACINE, '.env') });

// Le serveur et le test doivent signer le cookie utilisateur avec le MEME secret.
// S'il est absent (dev), on en fixe un pour ce process: la valeur n'est jamais
// affichee et ne sert qu'a ce test.
if (!process.env.HMAC_SECRET) process.env.HMAC_SECRET = nodeCrypto.randomBytes(32).toString('hex');

const PORT = 3204;
const BASE = `http://127.0.0.1:${PORT}`;
const PORT_TIER2_OFF = 3206; // 2e serveur: palier LootLabs "2 pubs" DESACTIVE
const BASE_TIER2_OFF = `http://127.0.0.1:${PORT_TIER2_OFF}`;
const STUB_PORT = 3205; // stub local de l'API de verification Work.ink
const DISCORD_ID = '909000000000000004'; // utilisateur de test (compte fictif)

// Secrets de test: generes ici, jamais affiches, jamais ceux de production.
const LOOTLABS_SECRET_TEST = nodeCrypto.randomBytes(16).toString('hex');
const WORKINK_TOKEN_VALIDE = 'stub-' + nodeCrypto.randomUUID();

let echecs = 0;
function verifie(intitule, condition, detail) {
  console.log(`${condition ? '  OK  ' : '  ECHEC'} ${intitule}${detail ? ' -> ' + detail : ''}`);
  if (!condition) echecs++;
}

// ---------- Stub local de l'API Work.ink (aucun appel reseau reel) ----------
// Reproduit le contrat documente: GET /_api/v2/token/isValid/<token>[?deleteToken=1]
// -> { valid, deleted, info: { token, createdAt, byIp, linkId } }
function demarrerStub() {
  const consommes = new Set();
  const serveur = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
    const m = url.pathname.match(/^\/token\/isValid\/(.+)$/);
    const token = m ? decodeURIComponent(m[1]) : null;
    const singleUse = url.searchParams.get('deleteToken') === '1';
    if (!token || token !== WORKINK_TOKEN_VALIDE || (singleUse && consommes.has(token))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, deleted: false }));
      return;
    }
    if (singleUse) consommes.add(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        valid: true,
        deleted: singleUse,
        info: { token, createdAt: Date.now(), byIp: '198.51.100.7', linkId: 10345 },
      })
    );
  });
  return new Promise((resolve) => serveur.listen(STUB_PORT, '127.0.0.1', () => resolve(serveur)));
}

// ---------- Serveurs de test ----------
const enfants = [];
function demarrerServeur(port, envSup) {
  const enfant = spawn(process.execPath, ['src/index.js'], {
    cwd: RACINE,
    env: { ...process.env, PORT: String(port), SCHEDULERS: 'off', PUBLIC_URL: '', ...envSup },
    stdio: 'ignore',
  });
  enfants.push(enfant);
  return enfant;
}
const arret = () => {
  for (const enfant of enfants) {
    try { enfant.kill(); } catch (_) { /* deja mort */ }
  }
};

const attendre = async (base) => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(`${base}/ping`);
      if (r.ok) return true;
    } catch (_) { /* pas encore pret */ }
  }
  return false;
};

const faireAppel = (base) => async (methode, chemin, corps, cookie) => {
  const entetes = {};
  if (corps !== undefined) entetes['content-type'] = 'application/json';
  if (cookie) entetes.cookie = cookie;
  const r = await fetch(`${base}${chemin}`, {
    method: methode,
    headers: entetes,
    body: corps === undefined ? undefined : JSON.stringify(corps),
    signal: AbortSignal.timeout(20000),
  });
  const texte = await r.text();
  let json = {};
  try { json = JSON.parse(texte); } catch (_) { json = { texte }; }
  return { status: r.status, corps: json, texte };
};
const appel = faireAppel(BASE);
const appelTier2Off = faireAppel(BASE_TIER2_OFF);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  (saute: DATABASE_URL absent de cet environnement)');
    process.exit(0);
  }
  const { Client } = require(path.join(RACINE, 'node_modules', 'pg'));
  const { sslOptions, urlSansSslmode } = require(path.join(RACINE, 'src', 'db-ssl'));
  const discordService = require(path.join(RACINE, 'src', 'services', 'discord'));

  const c = new Client({
    connectionString: urlSansSslmode(process.env.DATABASE_URL),
    ssl: sslOptions(process.env.DATABASE_URL),
  });
  await c.connect();

  // ---------- Base: colonnes de la migration presentes ----------
  const colonnes = await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'll_sessions' AND column_name IN ('provider', 'duration_hours', 'ad_count')`
  );
  if (colonnes.rows.length < 3) {
    await c.end();
    console.error(
      '  ECHEC: ll_sessions sans les colonnes provider/duration_hours/ad_count — appliquer ' +
        'db/migration-provider-sessions.sql PUIS db/migration-session-ads.sql (npm run migrate)'
    );
    process.exit(1);
  }
  const metaAdCount = await c.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'll_sessions' AND column_name = 'ad_count'`
  );
  const adCount = metaAdCount.rows[0] || {};
  verifie(
    'migration-session-ads.sql appliquee (ad_count entier, NOT NULL, defaut 1)',
    adCount.data_type === 'integer' && adCount.is_nullable === 'NO' && String(adCount.column_default) === '1',
    `type=${adCount.data_type} nullable=${adCount.is_nullable} defaut=${adCount.column_default}`
  );
  const indexAdCount = await c.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'll_sessions' AND indexname = 'idx_ll_sessions_provider_ads'`
  );
  verifie('migration-session-ads.sql: index (provider, ad_count) present', indexAdCount.rows.length === 1);
  const sansPalier = await c.query(
    `SELECT COUNT(*)::int AS c FROM ll_sessions WHERE ad_count IS NULL`
  );
  verifie('aucune session sans palier (ad_count NULL) apres backfill', sansPalier.rows[0].c === 0,
    `${sansPalier.rows[0].c} ligne(s)`);

  const PUID_LOOTLABS = 'test-ll-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_LOOTLABS_2ADS = 'test-ll2-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_LOOTLABS_PALIER = 'test-llpalier-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_LOOTLABS_ANCIEN = 'test-llancien-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_LOOTLABS_LEGACY = 'test-lllegacy-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_WORKINK = 'test-wi-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_WORKINK_REJET = 'test-wi-' + nodeCrypto.randomBytes(24).toString('hex');
  const TOKEN_REJET = 'stub-invalide-' + nodeCrypto.randomBytes(8).toString('hex');
  const PUID_TRACES = [
    PUID_LOOTLABS,
    PUID_LOOTLABS_2ADS,
    PUID_LOOTLABS_PALIER,
    PUID_LOOTLABS_ANCIEN,
    PUID_LOOTLABS_LEGACY,
    PUID_WORKINK,
    PUID_WORKINK_REJET,
  ];
  const UNIQUE_1ADS = 'test-uniq-' + nodeCrypto.randomBytes(8).toString('hex');
  const UNIQUE_2ADS_1 = 'test-uniq2a-' + nodeCrypto.randomBytes(8).toString('hex');
  const UNIQUE_2ADS_2 = 'test-uniq2b-' + nodeCrypto.randomBytes(8).toString('hex');
  const UNIQUE_PALIER = 'test-uniqpalier-' + nodeCrypto.randomBytes(8).toString('hex');
  const UNIQUE_ANCIEN_1 = 'test-uniqancien1-' + nodeCrypto.randomBytes(8).toString('hex');
  const UNIQUE_ANCIEN_2 = 'test-uniqancien2-' + nodeCrypto.randomBytes(8).toString('hex');
  const UNIQUE_LEGACY = 'test-uniqlegacy-' + nodeCrypto.randomBytes(8).toString('hex');

  const nettoyage = async () => {
    try {
      // Ordre impose par les cles etrangeres: ll_sessions.key_id -> keys(id).
      const cles = await c.query(
        'SELECT key_id FROM ll_sessions WHERE puid = ANY($1) AND key_id IS NOT NULL',
        [PUID_TRACES]
      );
      await c.query('DELETE FROM postbacks WHERE puid = ANY($1)', [PUID_TRACES]);
      await c.query('DELETE FROM ll_sessions WHERE puid = ANY($1)', [PUID_TRACES]);
      if (cles.rows.length) {
        await c.query('DELETE FROM keys WHERE id = ANY($1)', [cles.rows.map((r) => r.key_id)]);
      }
      await c.query('DELETE FROM referrals WHERE referred_discord_id = $1', [DISCORD_ID]);
    } catch (e) {
      console.error('  (nettoyage partiel:', e.message + ')');
    }
  };

  await nettoyage();

  // ---------- Sessions de test inserees en base ----------
  // On n'appelle JAMAIS la creation de lien d'une regie (aucun appel reseau):
  // la session est posee directement, comme si la regie avait redirige l'utilisateur.
  // IP volontairement hors loopback: un postback ne peut pas venir du client.
  const insererSession = async ({ puid, provider, durationHours, ip, ads, tasksRequired }) => {
    await c.query(
      `INSERT INTO ll_sessions (puid, key_id, tasks_required, status, ip, owner_discord_id, started_at, provider, duration_hours, ad_count, created_at)
       VALUES ($1, NULL, $2, 'pending', $3, $4, now() - interval '2 minutes', $5, $6, $7, now() - interval '2 minutes')`,
      [puid, tasksRequired, ip, DISCORD_ID, provider, durationHours, ads]
    );
  };

  // LootLabs 1 pub (12 h): chemin historique, doit rester identique.
  await insererSession({
    puid: PUID_LOOTLABS, provider: 'lootlabs', durationHours: 12, ip: '203.0.113.11', ads: 1, tasksRequired: 1,
  });
  // LootLabs 2 pubs (24 h): palier ajoute.
  await insererSession({
    puid: PUID_LOOTLABS_2ADS, provider: 'lootlabs', durationHours: 24, ip: '203.0.113.21', ads: 2, tasksRequired: 2,
  });
  // LootLabs 2 pubs mais UN SEUL point de controle: palier incoherent -> refus.
  await insererSession({
    puid: PUID_LOOTLABS_PALIER, provider: 'lootlabs', durationHours: 24, ip: '203.0.113.22', ads: 2, tasksRequired: 1,
  });
  // Work.ink 1 pub (24 h) + une seconde pour les refus.
  await insererSession({
    puid: PUID_WORKINK, provider: 'workink', durationHours: 24, ip: '203.0.113.12', ads: 1, tasksRequired: 1,
  });
  await insererSession({
    puid: PUID_WORKINK_REJET, provider: 'workink', durationHours: 24, ip: '203.0.113.13', ads: 1, tasksRequired: 1,
  });

  // ---------- Stubs + serveurs de test ----------
  const stub = await demarrerStub();
  const arretTout = () => {
    arret();
    try { stub.close(); } catch (_) { /* deja ferme */ }
  };
  process.on('exit', arretTout);

  // Serveur 1: regie Work.ink NON configuree (etat reel de l'utilisateur), palier
  // LootLabs "2 pubs" ACTIF. Durees explicites par palier.
  demarrerServeur(PORT, {
    // Regie Work.ink NON configuree (etat reel de l'utilisateur: pas de compte).
    WORKINK_API_KEY: '',
    WORKINK_LINK_ENDPOINT: '',
    WORKINK_LINK_URL: '',
    // Verifications locales uniquement: le stub remplace l'API Work.ink.
    WORKINK_VERIFY_URL: `http://127.0.0.1:${STUB_PORT}/token/isValid`,
    // Signature du postback LootLabs: valeur de test, jamais affichee.
    LOOTLABS_POSTBACK_SECRET: LOOTLABS_SECRET_TEST,
    // Durees par palier verifiees explicitement.
    LOOTLABS_DURATION_HOURS: '12',
    LOOTLABS_DURATION_HOURS_2: '24',
    WORKINK_DURATION_HOURS: '24',
    LOOTLABS_TIER2_ENABLED: 'true',
  });
  // Serveur 2: palier LootLabs "2 pubs" DESACTIVE -> la carte est annoncee
  // indisponible et /api/key/start le refuse proprement (aucun 500).
  demarrerServeur(PORT_TIER2_OFF, {
    WORKINK_API_KEY: '',
    WORKINK_LINK_ENDPOINT: '',
    WORKINK_LINK_URL: '',
    WORKINK_VERIFY_URL: `http://127.0.0.1:${STUB_PORT}/token/isValid`,
    LOOTLABS_POSTBACK_SECRET: LOOTLABS_SECRET_TEST,
    LOOTLABS_DURATION_HOURS: '12',
    LOOTLABS_DURATION_HOURS_2: '24',
    WORKINK_DURATION_HOURS: '24',
    LOOTLABS_TIER2_ENABLED: 'false',
  });

  const cookieUser = `ks_user=${discordService.signUserCookie(DISCORD_ID)}`;
  const minutesRestantes = (dateIso, heures) =>
    Math.round(((new Date(dateIso).getTime() - Date.now()) / 3600000) * 10) / 10 - heures;
  // Lecture de la cle liee a une session (duration_hours + expires_at).
  const cleDeLaSession = (puid) =>
    c.query(
      `SELECT k.duration_hours, k.expires_at FROM keys k
        JOIN ll_sessions s ON s.key_id = k.id WHERE s.puid = $1`,
      [puid]
    );
  const etatSession = (puid) =>
    c.query(
      'SELECT status, tasks_done, tasks_required, ad_count, duration_hours, provider, completion_token, key_id FROM ll_sessions WHERE puid = $1',
      [puid]
    );
  const nombreDeCles = async (puid) =>
    (await c.query(
      `SELECT COUNT(*)::int AS c FROM keys k JOIN ll_sessions s ON s.key_id = k.id WHERE s.puid = $1`,
      [puid]
    )).rows[0].c;

  // La colonne ad_count est NOT NULL depuis la migration: pour inserer la session
  // ANTERIEURE (ad_count NULL) on assouplit la contrainte le temps de la creation
  // et du test de CETTE SEULE ligne, puis on la retablit (voir etape 9).
  let legacyAssoupli = false;
  const restaurerContrainteLegacy = async () => {
    if (!legacyAssoupli) return;
    legacyAssoupli = false;
    try {
      const cles = await c.query(
        'SELECT key_id FROM ll_sessions WHERE puid = $1 AND key_id IS NOT NULL',
        [PUID_LOOTLABS_LEGACY]
      );
      await c.query('DELETE FROM postbacks WHERE puid = $1', [PUID_LOOTLABS_LEGACY]);
      await c.query('DELETE FROM ll_sessions WHERE puid = $1', [PUID_LOOTLABS_LEGACY]);
      if (cles.rows.length) {
        await c.query('DELETE FROM keys WHERE id = ANY($1)', [cles.rows.map((r) => r.key_id)]);
      }
      await c.query('ALTER TABLE ll_sessions ALTER COLUMN ad_count SET NOT NULL');
      const etat = await c.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'll_sessions' AND column_name = 'ad_count'`
      );
      verifie('contrainte ad_count NOT NULL restauree apres le test de session anterieure',
        etat.rows[0] && etat.rows[0].is_nullable === 'NO', etat.rows[0] ? `nullable=${etat.rows[0].is_nullable}` : '');
    } catch (e) {
      console.error('  (restauration de la contrainte ad_count impossible:', e.message + ')');
      echecs++;
    }
  };

  try {
    if (!(await attendre(BASE))) {
      console.error('  ECHEC: le serveur n\'a pas repondu sur /ping');
      arretTout();
      process.exit(1);
    }

    // ---------- 1. Paliers annonces par la configuration publique ----------
    const conf = await appel('GET', '/api/config/public');
    verifie('configuration publique accessible (200)', conf.status === 200, `HTTP ${conf.status}`);
    const providers = Array.isArray(conf.corps.providers) ? conf.corps.providers : [];
    const ll = providers.find((p) => p.id === 'lootlabs');
    const ll2 = providers.find((p) => p.id === 'lootlabs_2ads');
    const wi = providers.find((p) => p.id === 'workink');
    verifie('les trois paliers sont decrits (lootlabs, lootlabs_2ads, workink)', !!ll && !!ll2 && !!wi,
      providers.map((p) => p.id).join(', '));
    verifie('LootLabs 1 pub disponible avec une cle de 12 h',
      ll && ll.available === true && ll.adCount === 1 && ll.durationHours === 12,
      ll ? `available=${ll.available} pubs=${ll.adCount} duree=${ll.durationHours}` : '');
    verifie('LootLabs 2 pubs disponible avec 2 pubs et une cle de 24 h',
      ll2 && ll2.available === true && ll2.adCount === 2 && ll2.durationHours === 24,
      ll2 ? `available=${ll2.available} pubs=${ll2.adCount} duree=${ll2.durationHours}` : '');
    verifie('Work.ink NON configuree annoncee indisponible',
      wi && wi.available === false, wi ? `available=${wi.available}` : '');
    verifie('Work.ink indisponible avec une raison explicite',
      wi && typeof wi.reason === 'string' && wi.reason.length > 0, wi ? String(wi.reason) : '');
    verifie('Work.ink: 1 seule annonce, cle de 24 h',
      wi && wi.adCount === 1 && wi.durationHours === 24, wi ? `pubs=${wi.adCount} duree=${wi.durationHours}` : '');

    // ---------- 2. Refus propres du demarrage de session ----------
    const refus = await appel('POST', '/api/key/start', { provider: 'workink' }, cookieUser);
    verifie('demarrage Work.ink refuse sans erreur 500', refus.status !== 500, `HTTP ${refus.status}`);
    verifie('refus explicite: provider_unavailable', refus.corps.reason === 'provider_unavailable',
      `HTTP ${refus.status} raison=${refus.corps.reason || 'aucune'}`);
    verifie('refus: regie nommee dans la reponse', refus.corps.provider === 'workink');
    verifie('refus: message lisible en anglais', typeof refus.corps.error === 'string' && refus.corps.error.length > 0);
    verifie('refus: aucune session creee',
      (await c.query(
        `SELECT COUNT(*)::int AS c FROM ll_sessions
          WHERE provider = 'workink' AND created_at > now() - interval '1 minute'`
      )).rows[0].c === 0);

    const inconnu = await appel('POST', '/api/key/start', { provider: 'pas-une-regie' }, cookieUser);
    verifie('regie inconnue refusee (400, pas 500)',
      inconnu.status === 400 && inconnu.corps.reason === 'invalid_provider',
      `HTTP ${inconnu.status} raison=${inconnu.corps.reason || 'aucune'}`);

    // Postback LootLabs sur une session Work.ink: chaque regie ne delivre que
    // les sessions de SON palier/protocole.
    const croiseeLoot = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_WORKINK_REJET}&unique_id=${UNIQUE_PALIER}-x` +
        `&ip=198.51.100.9&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback LootLabs refuse sur une session Work.ink (403)',
      croiseeLoot.status === 403, `HTTP ${croiseeLoot.status}`);

    // ---------- 3. NON-REGRESSION: LootLabs 1 pub -> cle de 12 h ----------
    const sansSecret = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS}&unique_id=${UNIQUE_1ADS}-ns&ip=198.51.100.21`
    );
    verifie('postback LootLabs sans signature refuse (403)', sansSecret.status === 403, `HTTP ${sansSecret.status}`);

    const pbLl = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS}&unique_id=${UNIQUE_1ADS}` +
        `&ip=198.51.100.21&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback LootLabs signe accepte (1 pub)', pbLl.status === 200, `HTTP ${pbLl.status} ${pbLl.texte.slice(0, 40)}`);

    const livraisonLl = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS}`, undefined, cookieUser);
    verifie('cle LootLabs 1 pub delivree',
      livraisonLl.status === 200 && livraisonLl.corps.status === 'completed' && !!livraisonLl.corps.key,
      `HTTP ${livraisonLl.status} ${livraisonLl.corps.status || ''}`);
    const cleLl = await cleDeLaSession(PUID_LOOTLABS);
    verifie('cle LootLabs 1 pub gravee avec duration_hours = 12',
      cleLl.rows[0] && Number(cleLl.rows[0].duration_hours) === 12,
      cleLl.rows[0] ? `duration_hours=${cleLl.rows[0].duration_hours}` : 'cle absente');
    verifie('cle LootLabs 1 pub expire dans ~12 h (expires_at)',
      cleLl.rows[0] && Math.abs(minutesRestantes(cleLl.rows[0].expires_at, 12)) < 0.2,
      cleLl.rows[0] ? `ecart=${minutesRestantes(cleLl.rows[0].expires_at, 12)} h` : '');
    const etatLl = await etatSession(PUID_LOOTLABS);
    verifie('session LootLabs 1 pub tracee (provider, ad_count, duration_hours)',
      etatLl.rows[0] && etatLl.rows[0].provider === 'lootlabs' &&
        Number(etatLl.rows[0].ad_count) === 1 && Number(etatLl.rows[0].duration_hours) === 12,
      etatLl.rows[0] ? `provider=${etatLl.rows[0].provider} pubs=${etatLl.rows[0].ad_count} duree=${etatLl.rows[0].duration_hours}` : '');

    // Refus d'une cle deja delivree pour la meme session.
    const rejeuLl = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS}&unique_id=${UNIQUE_1ADS}-rejeu` +
        `&ip=198.51.100.21&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback LootLabs rejoue apres livraison (409)',
      rejeuLl.status === 409 && /already delivered/.test(rejeuLl.texte), `HTTP ${rejeuLl.status} ${rejeuLl.texte.slice(0, 40)}`);
    const rejeuStatus = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS}`, undefined, cookieUser);
    verifie('seconde livraison de la meme session refusee (already_claimed)',
      rejeuStatus.status === 409 && rejeuStatus.corps.status === 'already_claimed',
      `HTTP ${rejeuStatus.status} ${rejeuStatus.corps.status || ''}`);
    verifie('aucune seconde cle pour la meme session (1 pub)', (await nombreDeCles(PUID_LOOTLABS)) === 1);

    // ---------- 4. Refus d'un postback qui ne correspond pas au palier grave ----------
    // Session 2 pubs dont tasks_required = 1: les deux references divergent.
    const palierIncoherent = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_PALIER}&unique_id=${UNIQUE_PALIER}` +
        `&ip=198.51.100.22&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback hors palier de la session refuse (403)',
      palierIncoherent.status === 403 && /tier mismatch/.test(palierIncoherent.texte),
      `HTTP ${palierIncoherent.status} ${palierIncoherent.texte.slice(0, 40)}`);
    const etatPalier = await etatSession(PUID_LOOTLABS_PALIER);
    verifie('session hors palier: toujours en attente, aucune cle, aucun token',
      etatPalier.rows[0] && etatPalier.rows[0].status === 'pending' &&
        etatPalier.rows[0].tasks_done === 0 && !etatPalier.rows[0].completion_token && !etatPalier.rows[0].key_id,
      etatPalier.rows[0] ? `${etatPalier.rows[0].status}/${etatPalier.rows[0].tasks_done}` : '');
    verifie('session hors palier: aucune cle creee', (await nombreDeCles(PUID_LOOTLABS_PALIER)) === 0);

    // ---------- 5. LootLabs 2 pubs -> cle de 24 h apres 2 pubs REELLES ----------
    // Le client tente d'annoncer lui-meme "1 pub" dans l'URL du postback: ces
    // parametres doivent etre IGNORES (le palier vient de la session).
    const pb2ads1 = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_2ADS}&unique_id=${UNIQUE_2ADS_1}` +
        `&ip=198.51.100.23&secret=${LOOTLABS_SECRET_TEST}&ad_count=1&number_of_tasks=1&tasks=1`
    );
    verifie('postback 1/2 du palier 2 pubs accepte (comptabilise)',
      pb2ads1.status === 200, `HTTP ${pb2ads1.status} ${pb2ads1.texte.slice(0, 40)}`);

    const apres1Pub = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS_2ADS}`, undefined, cookieUser);
    verifie('APRES 1 SEULE PUB: aucune cle delivree (session encore en attente)',
      apres1Pub.status === 200 && apres1Pub.corps.status === 'pending' && !apres1Pub.corps.key,
      `HTTP ${apres1Pub.status} statut=${apres1Pub.corps.status || ''}`);
    verifie('APRES 1 SEULE PUB: 1 pub comptee sur 2 exigees',
      apres1Pub.corps.tasksDone === 1 && apres1Pub.corps.tasksRequired === 2,
      `faites=${apres1Pub.corps.tasksDone} exigees=${apres1Pub.corps.tasksRequired}`);
    const etatApres1 = await etatSession(PUID_LOOTLABS_2ADS);
    verifie('APRES 1 SEULE PUB: session en attente, aucun token, aucune cle',
      etatApres1.rows[0] && etatApres1.rows[0].status === 'pending' &&
        etatApres1.rows[0].tasks_done === 1 && !etatApres1.rows[0].completion_token && !etatApres1.rows[0].key_id,
      etatApres1.rows[0] ? `${etatApres1.rows[0].status}/${etatApres1.rows[0].tasks_done} token=${etatApres1.rows[0].completion_token ? 'oui' : 'non'}` : '');
    verifie('APRES 1 SEULE PUB: aucune cle creee en base', (await nombreDeCles(PUID_LOOTLABS_2ADS)) === 0);

    // Rejeu du MEME postback (meme unique_id): la pub ne doit pas compter deux fois.
    const pb2ads1Rejeu = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_2ADS}&unique_id=${UNIQUE_2ADS_1}` +
        `&ip=198.51.100.23&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback rejoue (meme unique_id) ignore comme doublon',
      pb2ads1Rejeu.status === 200 && /duplicate/.test(pb2ads1Rejeu.texte),
      `HTTP ${pb2ads1Rejeu.status} ${pb2ads1Rejeu.texte.slice(0, 40)}`);
    const etatApres1Rejeu = await etatSession(PUID_LOOTLABS_2ADS);
    verifie('apres rejeu: toujours 1 pub comptee, aucune cle',
      etatApres1Rejeu.rows[0] && etatApres1Rejeu.rows[0].tasks_done === 1 && !etatApres1Rejeu.rows[0].key_id,
      etatApres1Rejeu.rows[0] ? `faites=${etatApres1Rejeu.rows[0].tasks_done}` : '');
    verifie('apres rejeu: aucune cle creee', (await nombreDeCles(PUID_LOOTLABS_2ADS)) === 0);

    // Seconde pub REELLE (unique_id distinct): la cle de 24 h est delivree.
    const pb2ads2 = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_2ADS}&unique_id=${UNIQUE_2ADS_2}` +
        `&ip=198.51.100.23&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback 2/2 du palier 2 pubs accepte', pb2ads2.status === 200, `HTTP ${pb2ads2.status} ${pb2ads2.texte.slice(0, 40)}`);

    const livraison2ads = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS_2ADS}`, undefined, cookieUser);
    verifie('cle LootLabs 2 pubs delivree apres les 2 pubs',
      livraison2ads.status === 200 && livraison2ads.corps.status === 'completed' && !!livraison2ads.corps.key,
      `HTTP ${livraison2ads.status} ${livraison2ads.corps.status || ''}`);
    const cle2ads = await cleDeLaSession(PUID_LOOTLABS_2ADS);
    verifie('cle LootLabs 2 pubs gravee avec duration_hours = 24',
      cle2ads.rows[0] && Number(cle2ads.rows[0].duration_hours) === 24,
      cle2ads.rows[0] ? `duration_hours=${cle2ads.rows[0].duration_hours}` : 'cle absente');
    verifie('cle LootLabs 2 pubs expire dans ~24 h (expires_at)',
      cle2ads.rows[0] && Math.abs(minutesRestantes(cle2ads.rows[0].expires_at, 24)) < 0.2,
      cle2ads.rows[0] ? `ecart=${minutesRestantes(cle2ads.rows[0].expires_at, 24)} h` : '');
    const etat2ads = await etatSession(PUID_LOOTLABS_2ADS);
    verifie('session LootLabs 2 pubs tracee (provider, ad_count=2, duration_hours=24)',
      etat2ads.rows[0] && etat2ads.rows[0].provider === 'lootlabs' &&
        Number(etat2ads.rows[0].ad_count) === 2 && Number(etat2ads.rows[0].duration_hours) === 24,
      etat2ads.rows[0] ? `provider=${etat2ads.rows[0].provider} pubs=${etat2ads.rows[0].ad_count} duree=${etat2ads.rows[0].duration_hours}` : '');

    // Postback tardif apres livraison: la session ne doit pas se re-armer.
    const pb2adsTardif = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_2ADS}&unique_id=${UNIQUE_2ADS_2}-tardif` +
        `&ip=198.51.100.23&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback rejoue apres livraison (2 pubs) refuse (409)',
      pb2adsTardif.status === 409 && /already delivered/.test(pb2adsTardif.texte),
      `HTTP ${pb2adsTardif.status} ${pb2adsTardif.texte.slice(0, 40)}`);
    verifie('aucune seconde cle pour la session 2 pubs', (await nombreDeCles(PUID_LOOTLABS_2ADS)) === 1);

    // ---------- 6. Work.ink 1 pub -> cle de 24 h ----------
    // La regie est NON configuree (pas de cle API): le retour d'une session
    // ouverte reste neanmoins verifiable par le token officiel.
    const pbWi = await appel(
      'GET',
      `/api/workink/postback?puid=${PUID_WORKINK}&hash=${WORKINK_TOKEN_VALIDE}`
    );
    verifie('postback Work.ink accepte (token verifie, sans cle API configuree)',
      pbWi.status === 200 && /ok/.test(pbWi.texte), `HTTP ${pbWi.status} ${pbWi.texte.slice(0, 40)}`);
    const livraisonWi = await appel('GET', `/api/key/status?puid=${PUID_WORKINK}`, undefined, cookieUser);
    verifie('cle Work.ink delivree', livraisonWi.status === 200 && !!livraisonWi.corps.key,
      `HTTP ${livraisonWi.status} ${livraisonWi.corps.status || ''}`);
    const cleWi = await cleDeLaSession(PUID_WORKINK);
    verifie('cle Work.ink gravee avec duration_hours = 24',
      cleWi.rows[0] && Number(cleWi.rows[0].duration_hours) === 24,
      cleWi.rows[0] ? `duration_hours=${cleWi.rows[0].duration_hours}` : 'cle absente');
    verifie('cle Work.ink expire dans ~24 h (expires_at)',
      cleWi.rows[0] && Math.abs(minutesRestantes(cleWi.rows[0].expires_at, 24)) < 0.2,
      cleWi.rows[0] ? `ecart=${minutesRestantes(cleWi.rows[0].expires_at, 24)} h` : '');
    const etatWi = await etatSession(PUID_WORKINK);
    verifie('session Work.ink tracee (provider, 1 annonce, duration_hours)',
      etatWi.rows[0] && etatWi.rows[0].provider === 'workink' &&
        Number(etatWi.rows[0].ad_count) === 1 && Number(etatWi.rows[0].duration_hours) === 24,
      etatWi.rows[0] ? `provider=${etatWi.rows[0].provider} annonces=${etatWi.rows[0].ad_count} duree=${etatWi.rows[0].duration_hours}` : '');

    const rejeuWi = await appel('GET', `/api/workink/postback?puid=${PUID_WORKINK}&hash=${WORKINK_TOKEN_VALIDE}`);
    verifie('postback Work.ink rejoue apres livraison (409)',
      rejeuWi.status === 409 && /already delivered/.test(rejeuWi.texte), `HTTP ${rejeuWi.status} ${rejeuWi.texte.slice(0, 40)}`);

    // ---------- 7. Verification de postback: token Work.ink invalide refuse ----------
    const pbInvalide = await appel('GET', `/api/workink/postback?puid=${PUID_WORKINK_REJET}&hash=${TOKEN_REJET}`);
    verifie('token Work.ink invalide refuse (403)', pbInvalide.status === 403, `HTTP ${pbInvalide.status}`);
    const reste = await c.query('SELECT status, tasks_done FROM ll_sessions WHERE puid = $1', [PUID_WORKINK_REJET]);
    verifie('session non completee apres un token invalide',
      reste.rows[0] && reste.rows[0].status === 'pending' && reste.rows[0].tasks_done === 0,
      reste.rows[0] ? `${reste.rows[0].status}/${reste.rows[0].tasks_done}` : '');
    const croiseeWi = await appel('GET', `/api/workink/postback?puid=${PUID_LOOTLABS}&hash=${TOKEN_REJET}`);
    verifie('postback Work.ink refuse sur une session LootLabs (403)', croiseeWi.status === 403, `HTTP ${croiseeWi.status}`);
    const croiseeWi2 = await appel('GET', `/api/workink/postback?puid=${PUID_LOOTLABS_2ADS}&hash=${TOKEN_REJET}`);
    verifie('postback Work.ink refuse sur une session LootLabs 2 pubs (403)',
      croiseeWi2.status === 403, `HTTP ${croiseeWi2.status}`);
    const sansParam = await appel('GET', `/api/workink/postback?puid=${PUID_WORKINK_REJET}`);
    verifie('postback Work.ink sans token refuse (400)', sansParam.status === 400, `HTTP ${sansParam.status}`);

    // ---------- 8. NON-REGRESSION d'une session ANTERIEURE a 2 points de controle ----------
    // La migration backfill ad_count = GREATEST(tasks_required, 1): une session
    // ouverte AVANT la troisieme offre, avec l'ancien reglage "2 taches" du panel
    // LootLabs, se retrouve donc avec ad_count = 2 et sa duree gravee a l'epoque
    // (12 h). Elle doit continuer a exiger 2 pubs ET a delivrer sa duree
    // d'origine: aucune session deja ouverte ne change de comportement.
    await insererSession({
      puid: PUID_LOOTLABS_ANCIEN, provider: 'lootlabs', durationHours: 12, ip: '203.0.113.25', ads: 2, tasksRequired: 2,
    });
    const pbAncien1 = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_ANCIEN}&unique_id=${UNIQUE_ANCIEN_1}` +
        `&ip=198.51.100.25&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('session anterieure (2 points de controle): 1re pub comptee, pas de cle',
      pbAncien1.status === 200 && (await nombreDeCles(PUID_LOOTLABS_ANCIEN)) === 0,
      `HTTP ${pbAncien1.status} ${pbAncien1.texte.slice(0, 40)}`);
    const pbAncien2 = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_ANCIEN}&unique_id=${UNIQUE_ANCIEN_2}` +
        `&ip=198.51.100.25&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('session anterieure: 2e pub acceptee', pbAncien2.status === 200, `HTTP ${pbAncien2.status}`);
    const livraisonAncien = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS_ANCIEN}`, undefined, cookieUser);
    verifie('session anterieure: cle delivree apres ses 2 pubs',
      livraisonAncien.status === 200 && !!livraisonAncien.corps.key,
      `HTTP ${livraisonAncien.status} ${livraisonAncien.corps.status || ''}`);
    const cleAncien = await cleDeLaSession(PUID_LOOTLABS_ANCIEN);
    verifie('session anterieure: duree d origine conservee (12 h, jamais 24 h)',
      cleAncien.rows[0] && Number(cleAncien.rows[0].duration_hours) === 12,
      cleAncien.rows[0] ? `duration_hours=${cleAncien.rows[0].duration_hours}` : 'cle absente');

    // ---------- 9. NON-REGRESSION d'une session ANTERIEURE (ad_count NULL) ----------
    // Cas reel: une session ouverte AVANT l'ajout de la colonne ad_count, donc une
    // ligne dont ad_count vaut NULL. Le code doit retomber sur 1 pub (comme avant
    // le palier 2 pubs) et delivrer une cle de 12 h sans aucune erreur.
    // La colonne etant NOT NULL depuis la migration, on assouplit la contrainte le
    // temps d'inserer et de tester CETTE SEULE ligne, puis on la retablit
    // immediatement (et dans le finally si le test echoue).
    await c.query('ALTER TABLE ll_sessions ALTER COLUMN ad_count DROP NOT NULL');
    legacyAssoupli = true;
    await insererSession({
      puid: PUID_LOOTLABS_LEGACY, provider: 'lootlabs', durationHours: 12, ip: '203.0.113.24', ads: null, tasksRequired: 1,
    });
    const legacyInsere = await etatSession(PUID_LOOTLABS_LEGACY);
    verifie('session anterieure inseree avec ad_count NULL (etat d avant migration)',
      legacyInsere.rows[0] && legacyInsere.rows[0].ad_count === null,
      legacyInsere.rows[0] ? `ad_count=${legacyInsere.rows[0].ad_count}` : '');
    const pbLegacy = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS_LEGACY}&unique_id=${UNIQUE_LEGACY}` +
        `&ip=198.51.100.24&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('session anterieure (ad_count NULL): postback accepte, aucune erreur',
      pbLegacy.status === 200, `HTTP ${pbLegacy.status} ${pbLegacy.texte.slice(0, 40)}`);
    const livraisonLegacy = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS_LEGACY}`, undefined, cookieUser);
    verifie('session anterieure (ad_count NULL): cle delivree',
      livraisonLegacy.status === 200 && !!livraisonLegacy.corps.key,
      `HTTP ${livraisonLegacy.status} ${livraisonLegacy.corps.status || ''}`);
    const cleLegacy = await cleDeLaSession(PUID_LOOTLABS_LEGACY);
    verifie('session anterieure (ad_count NULL): cle de 12 h comme avant',
      cleLegacy.rows[0] && Number(cleLegacy.rows[0].duration_hours) === 12,
      cleLegacy.rows[0] ? `duration_hours=${cleLegacy.rows[0].duration_hours}` : 'cle absente');
    verifie('session anterieure (ad_count NULL): expire dans ~12 h',
      cleLegacy.rows[0] && Math.abs(minutesRestantes(cleLegacy.rows[0].expires_at, 12)) < 0.2,
      cleLegacy.rows[0] ? `ecart=${minutesRestantes(cleLegacy.rows[0].expires_at, 12)} h` : '');
    await restaurerContrainteLegacy();

    // ---------- 10. Palier 2 pubs DESACTIVE (2e serveur): refus propre ----------
    if (!(await attendre(BASE_TIER2_OFF))) {
      verifie('second serveur (palier 2 pubs desactive) joignable', false, `pas de reponse sur ${PORT_TIER2_OFF}`);
    } else {
      const confOff = await appelTier2Off('GET', '/api/config/public');
      const offs = Array.isArray(confOff.corps.providers) ? confOff.corps.providers : [];
      const llOff = offs.find((p) => p.id === 'lootlabs');
      const ll2Off = offs.find((p) => p.id === 'lootlabs_2ads');
      verifie('palier 2 pubs desactive: annonce indisponible avec sa raison',
        ll2Off && ll2Off.available === false && ll2Off.reason === 'tier_disabled',
        ll2Off ? `available=${ll2Off.available} raison=${ll2Off.reason || 'aucune'}` : '');
      verifie('palier 2 pubs desactive: le palier 1 pub reste disponible (12 h)',
        llOff && llOff.available === true && llOff.durationHours === 12,
        llOff ? `available=${llOff.available} duree=${llOff.durationHours}` : '');
      const refusTier2 = await appelTier2Off('POST', '/api/key/start', { offer: 'lootlabs_2ads' }, cookieUser);
      verifie('palier 2 pubs desactive: demarrage refuse sans erreur 500 (503)',
        refusTier2.status === 503 && refusTier2.corps.reason === 'provider_unavailable',
        `HTTP ${refusTier2.status} raison=${refusTier2.corps.reason || 'aucune'}`);
      verifie('palier 2 pubs desactive: refus nominatif (offer + provider + message)',
        refusTier2.corps.offer === 'lootlabs_2ads' && refusTier2.corps.provider === 'lootlabs' &&
          typeof refusTier2.corps.error === 'string' && refusTier2.corps.error.length > 0);
      verifie('palier 2 pubs desactive: aucune session 2 pubs creee',
        (await c.query(
          `SELECT COUNT(*)::int AS c FROM ll_sessions
            WHERE provider = 'lootlabs' AND ad_count = 2 AND created_at > now() - interval '1 minute'`
        )).rows[0].c === 0);
      const offreInconnue = await appelTier2Off('POST', '/api/key/start', { offer: 'lootlabs_3ads' }, cookieUser);
      verifie('offre inconnue (lootlabs_3ads) refusee (400 invalid_provider)',
        offreInconnue.status === 400 && offreInconnue.corps.reason === 'invalid_provider',
        `HTTP ${offreInconnue.status} raison=${offreInconnue.corps.reason || 'aucune'}`);
    }

    // ---------- 11. Paliers et durees: controles locaux (aucun appel reseau) ----------
    const lootlabs = require(path.join(RACINE, 'src', 'services', 'lootlabs'));
    const workink = require(path.join(RACINE, 'src', 'services', 'workink'));
    // Etat de reference: aucun reglage optionnel, Work.ink NON configuree (comme
    // pour ce test, quel que soit le contenu du .env local).
    delete process.env.WORKINK_API_KEY;
    delete process.env.WORKINK_LINK_ENDPOINT;
    delete process.env.WORKINK_LINK_URL;
    delete process.env.LOOTLABS_DURATION_HOURS;
    delete process.env.LOOTLABS_DURATION_HOURS_2;
    delete process.env.WORKINK_DURATION_HOURS;
    delete process.env.LOOTLABS_TIER2_ENABLED;

    verifie('deux paliers LootLabs declares, pas plus (1 pub, 2 pubs)',
      JSON.stringify(lootlabs.adCounts()) === '[1,2]', JSON.stringify(lootlabs.adCounts()));
    verifie('duree par palier: 12 h pour 1 pub, 24 h pour 2 pubs',
      lootlabs.durationHours(1) === 12 && lootlabs.durationHours(2) === 24,
      `${lootlabs.durationHours(1)} h / ${lootlabs.durationHours(2)} h`);
    verifie('duree sans palier precise = 12 h (palier historique inchange)',
      lootlabs.durationHours() === 12 && lootlabs.DEFAULT_DURATION_HOURS === 12,
      `${lootlabs.durationHours()} h`);
    verifie('Work.ink: une seule annonce par cle, 24 h',
      workink.ADS_PER_KEY === 1 && workink.durationHours() === 24,
      `${workink.ADS_PER_KEY} annonce / ${workink.durationHours()} h`);
    verifie('bornes documentees number_of_tasks (1 a 5) conservees',
      lootlabs.MIN_TASKS === 1 && lootlabs.MAX_TASKS === 5,
      `${lootlabs.MIN_TASKS}..${lootlabs.MAX_TASKS}`);

    process.env.LOOTLABS_DURATION_HOURS = '18';
    process.env.LOOTLABS_DURATION_HOURS_2 = '30';
    process.env.WORKINK_DURATION_HOURS = '36';
    verifie('durees surchargeables INDEPENDAMMENT par palier (18 / 30 / 36 h)',
      lootlabs.durationHours(1) === 18 && lootlabs.durationHours(2) === 30 && workink.durationHours() === 36,
      `${lootlabs.durationHours(1)} / ${lootlabs.durationHours(2)} / ${workink.durationHours()}`);
    verifie('surcharger le palier 2 pubs ne change PAS le palier 1 pub',
      lootlabs.durationHours(1) === 18, `${lootlabs.durationHours(1)} h`);
    delete process.env.LOOTLABS_DURATION_HOURS;
    delete process.env.LOOTLABS_DURATION_HOURS_2;
    delete process.env.WORKINK_DURATION_HOURS;

    verifie('palier inconnu (3 pubs) annonce indisponible, raison explicite',
      lootlabs.unavailableReason(3) === 'unknown_ads_count' && lootlabs.isAvailable(3) === false,
      String(lootlabs.unavailableReason(3)));
    verifie('palier 2 pubs actif par defaut',
      lootlabs.isAvailable(2) === true && lootlabs.tier2Enabled() === true);

    process.env.LOOTLABS_TIER2_ENABLED = 'false';
    verifie('palier 2 pubs desactive -> tier_disabled, et palier 1 pub intact',
      lootlabs.unavailableReason(2) === 'tier_disabled' && lootlabs.isAvailable(2) === false &&
        lootlabs.isAvailable(1) === true && lootlabs.unavailableReason(1) === null,
      String(lootlabs.unavailableReason(2)));
    // Refus AVANT tout appel reseau: on neutralise fetch et on compte les appels.
    let appelsReseau = 0;
    const vraiFetch = global.fetch;
    global.fetch = () => {
      appelsReseau++;
      return Promise.reject(new Error('reseau interdit pendant ce test'));
    };
    try {
      const err2 = await lootlabs
        .createMonetizedLink({ ads: 2, puid: 'test-refus-' + nodeCrypto.randomBytes(8).toString('hex') })
        .then(() => null)
        .catch((e) => e);
      verifie('palier 2 pubs desactive: creation de lien refusee proprement (tier_disabled)',
        !!err2 && err2.reason === 'tier_disabled');
      const err3 = await lootlabs
        .createMonetizedLink({ ads: 3, puid: 'test-refus-' + nodeCrypto.randomBytes(8).toString('hex') })
        .then(() => null)
        .catch((e) => e);
      verifie('palier inconnu: creation de lien refusee proprement (unknown_ads_count)',
        !!err3 && err3.reason === 'unknown_ads_count');
    } finally {
      global.fetch = vraiFetch;
    }
    verifie('un palier refuse n\'entraine AUCUN appel reseau a la regie',
      appelsReseau === 0, `${appelsReseau} appel(s)`);
    delete process.env.LOOTLABS_TIER2_ENABLED;

    verifie('regie Work.ink non configuree -> indisponible avec raison',
      workink.isConfigured() === false && typeof workink.unavailableReason() === 'string',
      String(workink.unavailableReason()));
    const sansCle = await workink
      .createMonetizedLink({ durationHours: 24, puid: PUID_WORKINK })
      .then(() => null)
      .catch((e) => e);
    verifie('creation de lien Work.ink sans configuration: echec propre, aucun appel reseau',
      !!sansCle && sansCle.reason === 'missing_api_key');
  } catch (e) {
    console.error('  ECHEC:', e.message);
    echecs++;
  } finally {
    await restaurerContrainteLegacy();
    arretTout();
    await nettoyage();
    await c.end().catch(() => {});
  }

  console.log(
    `\n  VERDICT: ${echecs === 0
      ? 'les trois paliers (LootLabs 1 pub = 12 h, LootLabs 2 pubs = 24 h, Work.ink 1 pub = 24 h), leurs refus propres et la non-regression du palier historique (sessions anterieures comprises) se comportent comme prevu'
      : echecs + ' probleme(s)'}`
  );
  process.exit(echecs === 0 ? 0 : 1);
})().catch((e) => { console.error('  ECHEC:', e.message); process.exit(1); });
