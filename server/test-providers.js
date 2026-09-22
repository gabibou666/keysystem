/* Verifie le CHOIX DE LA REGIE PUBLICITAIRE (LootLabs / Work.ink) et la duree de
   la cle delivree pour chacune:
     - Work.ink NON configuree: refus propre du demarrage de session
       (raison provider_unavailable, jamais 500) + annonce de disponibilite
       correcte dans /api/config/public (available:false + raison);
     - durees appliquees: 12 h (LootLabs) et 24 h (Work.ink) reellement gravees
       dans la cle delivree (duration_hours + expires_at);
     - signature/verification du postback conservee pour les DEUX regies, et
       refus de toute cle deja delivree pour la meme session.
   Le serveur est demarre par ce test lui-meme, sur un port dedie. Les postbacks
   sont simules via HTTP local: AUCUN appel reseau a une regie, la verification
   du token Work.ink est servie par un stub local (WORKINK_VERIFY_URL).
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
      WHERE table_name = 'll_sessions' AND column_name IN ('provider', 'duration_hours')`
  );
  if (colonnes.rows.length < 2) {
    await c.end();
    console.error(
      '  ECHEC: ll_sessions sans les colonnes provider/duration_hours — appliquer db/migration-provider-sessions.sql (npm run migrate)'
    );
    process.exit(1);
  }

  const PUID_LOOTLABS = 'test-ll-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_WORKINK = 'test-wi-' + nodeCrypto.randomBytes(24).toString('hex');
  const PUID_WORKINK_REJET = 'test-wi-' + nodeCrypto.randomBytes(24).toString('hex');
  const TOKEN_REJET = 'stub-invalide-' + nodeCrypto.randomBytes(8).toString('hex');
  const PUID_TRACES = [PUID_LOOTLABS, PUID_WORKINK, PUID_WORKINK_REJET];
  const UNIQUE_LOOTLABS = 'test-uniq-' + nodeCrypto.randomBytes(8).toString('hex');

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
  const insererSession = async (puid, provider, durationHours, ip) => {
    await c.query(
      `INSERT INTO ll_sessions (puid, key_id, tasks_required, status, ip, owner_discord_id, started_at, provider, duration_hours, created_at)
       VALUES ($1, NULL, 1, 'pending', $2, $3, now() - interval '2 minutes', $4, $5, now() - interval '2 minutes')`,
      [puid, ip, DISCORD_ID, provider, durationHours]
    );
  };
  await insererSession(PUID_LOOTLABS, 'lootlabs', 12, '203.0.113.11');
  await insererSession(PUID_WORKINK, 'workink', 24, '203.0.113.12');
  await insererSession(PUID_WORKINK_REJET, 'workink', 24, '203.0.113.13');

  // ---------- Stub + serveur de test ----------
  const stub = await demarrerStub();
  const serveur = spawn(process.execPath, ['src/index.js'], {
    cwd: RACINE,
    env: {
      ...process.env,
      PORT: String(PORT),
      SCHEDULERS: 'off',
      PUBLIC_URL: '',
      // Regie Work.ink NON configuree (etat reel de l'utilisateur: pas de compte).
      WORKINK_API_KEY: '',
      WORKINK_LINK_ENDPOINT: '',
      // Verifications locales uniquement: le stub remplace l'API Work.ink.
      WORKINK_VERIFY_URL: `http://127.0.0.1:${STUB_PORT}/token/isValid`,
      // Signature du postback LootLabs: valeur de test, jamais affichee.
      LOOTLABS_POSTBACK_SECRET: LOOTLABS_SECRET_TEST,
      // Durees par defaut verifiees explicitement.
      LOOTLABS_DURATION_HOURS: '12',
      WORKINK_DURATION_HOURS: '24',
    },
    stdio: 'ignore',
  });
  const arret = () => {
    try { serveur.kill(); } catch (_) { /* deja mort */ }
    try { stub.close(); } catch (_) { /* deja ferme */ }
  };
  process.on('exit', arret);

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

  const appel = async (methode, chemin, corps, cookie) => {
    const entetes = {};
    if (corps !== undefined) entetes['content-type'] = 'application/json';
    if (cookie) entetes.cookie = cookie;
    const r = await fetch(`${BASE}${chemin}`, {
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

  const cookieUser = `ks_user=${discordService.signUserCookie(DISCORD_ID)}`;
  const minutesRestantes = (dateIso, heures) =>
    Math.round(((new Date(dateIso).getTime() - Date.now()) / 3600000) * 10) / 10 - heures;

  try {
    if (!(await attendre())) {
      console.error('  ECHEC: le serveur n\'a pas repondu sur /ping');
      arret();
      process.exit(1);
    }

    // ---------- 1. Disponibilite annoncee par la configuration publique ----------
    const conf = await appel('GET', '/api/config/public');
    verifie('configuration publique accessible (200)', conf.status === 200, `HTTP ${conf.status}`);
    const providers = Array.isArray(conf.corps.providers) ? conf.corps.providers : [];
    const ll = providers.find((p) => p.id === 'lootlabs');
    const wi = providers.find((p) => p.id === 'workink');
    verifie('les deux regies sont decrites (lootlabs + workink)', !!ll && !!wi);
    verifie('LootLabs disponible avec une cle de 12 h', ll && ll.available === true && ll.durationHours === 12,
      ll ? `available=${ll.available} duree=${ll.durationHours}` : '');
    verifie('Work.ink NON configuree annoncee indisponible',
      wi && wi.available === false, wi ? `available=${wi.available}` : '');
    verifie('Work.ink indisponible avec une raison explicite',
      wi && typeof wi.reason === 'string' && wi.reason.length > 0, wi ? String(wi.reason) : '');
    verifie('Work.ink conserverait une cle de 24 h',
      wi && wi.durationHours === 24, wi ? `duree=${wi.durationHours}` : '');

    // ---------- 2. Refus propre du demarrage Work.ink non configuree ----------
    const refus = await appel('POST', '/api/key/start', { provider: 'workink' }, cookieUser);
    verifie('demarrage Work.ink refuse sans erreur 500', refus.status !== 500, `HTTP ${refus.status}`);
    verifie('refus explicite: provider_unavailable', refus.corps.reason === 'provider_unavailable',
      `HTTP ${refus.status} raison=${refus.corps.reason || 'aucune'}`);
    verifie('refus: regie nommee dans la reponse', refus.corps.provider === 'workink');
    verifie('refus: message lisible en anglais', typeof refus.corps.error === 'string' && refus.corps.error.length > 0);
    verifie('refus: aucune session creee',
      (await c.query(
        `SELECT COUNT(*)::int AS c FROM ll_sessions WHERE provider = 'workink' AND puid LIKE 'test-%' AND status = 'pending'`
      )).rows[0].c === 2);

    const inconnu = await appel('POST', '/api/key/start', { provider: 'pas-une-regie' }, cookieUser);
    verifie('regie inconnue refusee (400, pas 500)',
      inconnu.status === 400 && inconnu.corps.reason === 'invalid_provider',
      `HTTP ${inconnu.status} raison=${inconnu.corps.reason || 'aucune'}`);

    // ---------- 3. Duree LootLabs (12 h) via un postback simule ----------
    const pbLl = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS}&unique_id=${UNIQUE_LOOTLABS}` +
        `&ip=198.51.100.21&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback LootLabs signe accepte', pbLl.status === 200, `HTTP ${pbLl.status} ${pbLl.texte.slice(0, 40)}`);
    const sansSecret = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS}&unique_id=${UNIQUE_LOOTLABS}-2&ip=198.51.100.21`
    );
    verifie('postback LootLabs sans signature refuse (403)', sansSecret.status === 403, `HTTP ${sansSecret.status}`);

    const livraisonLl = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS}`, undefined, cookieUser);
    verifie('cle LootLabs delivree', livraisonLl.status === 200 && livraisonLl.corps.status === 'completed' && !!livraisonLl.corps.key,
      `HTTP ${livraisonLl.status} ${livraisonLl.corps.status || ''}`);
    const cleLl = await c.query(
      `SELECT k.duration_hours, k.expires_at FROM keys k
        JOIN ll_sessions s ON s.key_id = k.id WHERE s.puid = $1`,
      [PUID_LOOTLABS]
    );
    verifie('cle LootLabs gravee avec duration_hours = 12',
      cleLl.rows[0] && Number(cleLl.rows[0].duration_hours) === 12,
      cleLl.rows[0] ? `duration_hours=${cleLl.rows[0].duration_hours}` : 'cle absente');
    verifie('cle LootLabs expire dans ~12 h (expires_at)',
      cleLl.rows[0] && Math.abs(minutesRestantes(cleLl.rows[0].expires_at, 12)) < 0.2,
      cleLl.rows[0] ? `ecart=${minutesRestantes(cleLl.rows[0].expires_at, 12)} h` : '');
    const providerLl = await c.query('SELECT provider, duration_hours FROM ll_sessions WHERE puid = $1', [PUID_LOOTLABS]);
    verifie('session LootLabs tracee (provider + duration_hours)',
      providerLl.rows[0] && providerLl.rows[0].provider === 'lootlabs' && Number(providerLl.rows[0].duration_hours) === 12);

    // ---------- 4. Refus d'une cle deja delivree pour la meme session ----------
    const rejeuLl = await appel(
      'GET',
      `/api/lootlabs/postback?click_id=${PUID_LOOTLABS}&unique_id=${UNIQUE_LOOTLABS}-rejeu` +
        `&ip=198.51.100.21&secret=${LOOTLABS_SECRET_TEST}`
    );
    verifie('postback LootLabs rejoue apres livraison (409)',
      rejeuLl.status === 409 && /already delivered/.test(rejeuLl.texte), `HTTP ${rejeuLl.status} ${rejeuLl.texte.slice(0, 40)}`);
    const rejeuStatus = await appel('GET', `/api/key/status?puid=${PUID_LOOTLABS}`, undefined, cookieUser);
    verifie('seconde livraison de la meme session refusee (already_claimed)',
      rejeuStatus.status === 409 && rejeuStatus.corps.status === 'already_claimed',
      `HTTP ${rejeuStatus.status} ${rejeuStatus.corps.status || ''}`);
    verifie('aucune seconde cle pour la meme session',
      (await c.query(
        `SELECT COUNT(*)::int AS c FROM keys k JOIN ll_sessions s ON s.key_id = k.id WHERE s.puid = $1`,
        [PUID_LOOTLABS]
      )).rows[0].c === 1);

    // ---------- 5. Duree Work.ink (24 h) via un postback simule ----------
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
    const cleWi = await c.query(
      `SELECT k.duration_hours, k.expires_at FROM keys k
        JOIN ll_sessions s ON s.key_id = k.id WHERE s.puid = $1`,
      [PUID_WORKINK]
    );
    verifie('cle Work.ink gravee avec duration_hours = 24',
      cleWi.rows[0] && Number(cleWi.rows[0].duration_hours) === 24,
      cleWi.rows[0] ? `duration_hours=${cleWi.rows[0].duration_hours}` : 'cle absente');
    verifie('cle Work.ink expire dans ~24 h (expires_at)',
      cleWi.rows[0] && Math.abs(minutesRestantes(cleWi.rows[0].expires_at, 24)) < 0.2,
      cleWi.rows[0] ? `ecart=${minutesRestantes(cleWi.rows[0].expires_at, 24)} h` : '');
    const providerWi = await c.query('SELECT provider, duration_hours FROM ll_sessions WHERE puid = $1', [PUID_WORKINK]);
    verifie('session Work.ink tracee (provider + duration_hours)',
      providerWi.rows[0] && providerWi.rows[0].provider === 'workink' && Number(providerWi.rows[0].duration_hours) === 24);

    // Rejeu apres livraison: meme token, cle deja delivree.
    const rejeuWi = await appel('GET', `/api/workink/postback?puid=${PUID_WORKINK}&hash=${WORKINK_TOKEN_VALIDE}`);
    verifie('postback Work.ink rejoue apres livraison (409)',
      rejeuWi.status === 409 && /already delivered/.test(rejeuWi.texte), `HTTP ${rejeuWi.status} ${rejeuWi.texte.slice(0, 40)}`);

    // ---------- 6. Verification de postback: token Work.ink invalide refuse ----------
    const pbInvalide = await appel('GET', `/api/workink/postback?puid=${PUID_WORKINK_REJET}&hash=${TOKEN_REJET}`);
    verifie('token Work.ink invalide refuse (403)', pbInvalide.status === 403, `HTTP ${pbInvalide.status}`);
    const reste = await c.query('SELECT status, tasks_done FROM ll_sessions WHERE puid = $1', [PUID_WORKINK_REJET]);
    verifie('session non completee apres un token invalide',
      reste.rows[0] && reste.rows[0].status === 'pending' && reste.rows[0].tasks_done === 0,
      reste.rows[0] ? `${reste.rows[0].status}/${reste.rows[0].tasks_done}` : '');
    const croisee = await appel('GET', `/api/workink/postback?puid=${PUID_LOOTLABS}&hash=${TOKEN_REJET}`);
    verifie('postback Work.ink refuse sur une session LootLabs (403)', croisee.status === 403, `HTTP ${croisee.status}`);
    const sansParam = await appel('GET', `/api/workink/postback?puid=${PUID_WORKINK_REJET}`);
    verifie('postback Work.ink sans token refuse (400)', sansParam.status === 400, `HTTP ${sansParam.status}`);

    // ---------- 7. Durees surchargeables par variables d'environnement ----------
    const lootlabs = require(path.join(RACINE, 'src', 'services', 'lootlabs'));
    const workink = require(path.join(RACINE, 'src', 'services', 'workink'));
    // Etat de reference: Work.ink NON configuree (comme pour ce test, quel que
    // soit le contenu du .env local).
    delete process.env.WORKINK_API_KEY;
    delete process.env.WORKINK_LINK_ENDPOINT;
    delete process.env.LOOTLABS_DURATION_HOURS;
    delete process.env.WORKINK_DURATION_HOURS;
    verifie('durees par defaut: 12 h (LootLabs) et 24 h (Work.ink)',
      lootlabs.durationHours() === 12 && workink.durationHours() === 24,
      `${lootlabs.durationHours()} / ${workink.durationHours()}`);
    process.env.LOOTLABS_DURATION_HOURS = '18';
    process.env.WORKINK_DURATION_HOURS = '36';
    verifie('durees surchargeables par LOOTLABS_DURATION_HOURS / WORKINK_DURATION_HOURS',
      lootlabs.durationHours() === 18 && workink.durationHours() === 36,
      `${lootlabs.durationHours()} / ${workink.durationHours()}`);
    delete process.env.LOOTLABS_DURATION_HOURS;
    delete process.env.WORKINK_DURATION_HOURS;
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
    arret();
    await nettoyage();
    await c.end().catch(() => {});
  }

  console.log(
    `\n  VERDICT: ${echecs === 0
      ? 'le choix de la regie, ses refus propres et les durees de cle (12 h / 24 h) se comportent comme prevu'
      : echecs + ' probleme(s)'}`
  );
  process.exit(echecs === 0 ? 0 : 1);
})().catch((e) => { console.error('  ECHEC:', e.message); process.exit(1); });
