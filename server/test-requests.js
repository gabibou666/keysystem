/* Verifie les demandes de scripts: POST /api/requests (connexion obligatoire,
   doublon refuse), GET /api/requests/top (publique, sans connexion),
   GET /api/requests/mine + POST /api/requests/seen (popup une seule fois), et
   le RETRAIT AUTOMATIQUE des demandes quand un script est publie pour le jeu.
   Le serveur est demarre par ce test lui-meme, sur un port dedie.
   Sans DATABASE_URL (integration continue), le test s'annonce et se saute.
   Regle de fond: ce test n'affiche JAMAIS de secret (aucune valeur de .env, de
   cle ou de jeton) et nettoie ses lignes de test a la fin. */
'use strict';
const path = require('path');
const nodeCrypto = require('crypto');
const { spawn } = require('child_process');

const RACINE = __dirname;
require(path.join(RACINE, 'node_modules', 'dotenv')).config({ path: path.join(RACINE, '.env') });

// Le serveur et le test doivent signer le cookie utilisateur avec le MEME
// secret. S'il est absent (dev), on en fixe un pour ce process: la valeur n'est
// jamais affichee et ne sert qu'a ce test.
if (!process.env.HMAC_SECRET) process.env.HMAC_SECRET = nodeCrypto.randomBytes(32).toString('hex');

const PORT = 3201;
const BASE = `http://127.0.0.1:${PORT}`;
const DISCORD_ID = '909000000000000001'; // utilisateur de test (compte fictif)
let echecs = 0;

function verifie(intitule, condition, detail) {
  console.log(`${condition ? '  OK  ' : '  ECHEC'} ${intitule}${detail ? ' -> ' + detail : ''}`);
  if (!condition) echecs++;
}

// PlaceId de test: aleatoire et 9 chiffres, pour ne jamais tomber sur un jeu
// reel ni sur une donnee de production.
let PLACE_ID = 0;

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  (saute: DATABASE_URL absent de cet environnement)');
    process.exit(0);
  }
  const { Client } = require(path.join(RACINE, 'node_modules', 'pg'));
  const { sslOptions, urlSansSslmode } = require(path.join(RACINE, 'src', 'db-ssl'));
  const cryptoService = require(path.join(RACINE, 'src', 'services', 'crypto'));
  const discordService = require(path.join(RACINE, 'src', 'services', 'discord'));

  const c = new Client({
    connectionString: urlSansSslmode(process.env.DATABASE_URL),
    ssl: sslOptions(process.env.DATABASE_URL),
  });
  await c.connect();

  // ---------- Base: table presente + jeu de test libre ----------
  const table = await c.query(
    "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='script_requests'"
  );
  if (!table.rows.length) {
    await c.end();
    console.error('  ECHEC: table script_requests absente — appliquer db/migration-script-requests.sql (npm run migrate)');
    process.exit(1);
  }
  for (let essai = 0; essai < 10 && !PLACE_ID; essai++) {
    const candidat = 900000000 + Math.floor(Math.random() * 99999999);
    const occupe = await c.query(
      `SELECT 1 FROM game_info WHERE place_id = $1
        UNION ALL SELECT 1 FROM script_requests WHERE place_id = $1
        UNION ALL SELECT 1 FROM script_builds WHERE place_id = $1
        UNION ALL SELECT 1 FROM script_versions WHERE place_id = $1`,
      [candidat]
    );
    if (!occupe.rows.length) PLACE_ID = candidat;
  }
  if (!PLACE_ID) {
    await c.end();
    console.error('  ECHEC: aucun PlaceId de test libre trouve en base');
    process.exit(1);
  }

  const nettoyage = async () => {
    try {
      await c.query(
        `DELETE FROM ai_patches WHERE build_id IN (SELECT id FROM script_builds WHERE place_id = $1)`,
        [PLACE_ID]
      );
      await c.query('DELETE FROM script_builds WHERE place_id = $1', [PLACE_ID]);
      await c.query('DELETE FROM script_versions WHERE place_id = $1', [PLACE_ID]);
      await c.query('DELETE FROM script_requests WHERE place_id = $1', [PLACE_ID]);
      await c.query('DELETE FROM game_info WHERE place_id = $1', [PLACE_ID]);
      await c.query('DELETE FROM admin_sessions WHERE discord_id = $1', [DISCORD_ID]);
    } catch (e) {
      console.error('  (nettoyage partiel:', e.message + ')');
    }
  };

  await nettoyage();
  // Nom de jeu en cache: evite un appel a l'API Roblox pour un PlaceId fictif
  // et verifie que l'API sert bien le nom depuis game_info.
  const NOM_JEU = 'Jeu de test (demandes)';
  await c.query(
    `INSERT INTO game_info (place_id, name, icon_url, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (place_id) DO UPDATE SET name = $2, icon_url = $3, updated_at = now()`,
    [PLACE_ID, NOM_JEU, 'https://example.invalid/test-icon.png']
  );

  const cookieUser = `ks_user=${discordService.signUserCookie(DISCORD_ID)}`;

  // ---------- Serveur de test ----------
  const serveur = spawn(process.execPath, ['src/index.js'], {
    cwd: RACINE,
    env: { ...process.env, PORT: String(PORT), SCHEDULERS: 'off', PUBLIC_URL: '' },
    stdio: 'ignore',
  });
  const arret = () => { try { serveur.kill(); } catch (_) { /* deja mort */ } };
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
    return { status: r.status, corps: await r.json().catch(() => ({})) };
  };

  try {
    if (!(await attendre())) {
      console.error('  ECHEC: le serveur n\'a pas repondu sur /ping');
      arret();
      process.exit(1);
    }

    // ---------- 1. Sans connexion: la demande est refusee ----------
    const anon = await appel('POST', '/api/requests', { placeId: PLACE_ID, note: 'sans connexion' });
    verifie('demande sans connexion refusee (401)', anon.status === 401, `HTTP ${anon.status}`);
    verifie('aucune ligne creee pour une demande anonyme',
      (await c.query('SELECT COUNT(*)::int AS c FROM script_requests WHERE place_id = $1', [PLACE_ID])).rows[0].c === 0);

    // ---------- 2. Classement public: accessible sans connexion ----------
    const topVide = await appel('GET', '/api/requests/top');
    verifie('classement public accessible sans connexion (200)', topVide.status === 200, `HTTP ${topVide.status}`);
    verifie('classement public: liste de jeux renvoyee', Array.isArray(topVide.corps.games));
    verifie('classement public: aucun jeu de test avant la demande',
      !topVide.corps.games.some((g) => g.placeId === PLACE_ID));

    // ---------- 3. Creation avec un utilisateur de test ----------
    const cree = await appel('POST', '/api/requests', { placeId: PLACE_ID, note: 'merci !' }, cookieUser);
    verifie('demande acceptee pour un utilisateur connecte (200)', cree.status === 200 && cree.corps.ok === true, `HTTP ${cree.status}`);
    verifie('nom du jeu enregistre via le service roblox', cree.corps.gameName === NOM_JEU, String(cree.corps.gameName));
    const ligne = (await c.query(
      'SELECT id, status, fulfilled_at, notified_at, note FROM script_requests WHERE place_id = $1',
      [PLACE_ID]
    )).rows[0];
    verifie('ligne en base: status pending, non servie, non notifiee',
      ligne && ligne.status === 'pending' && ligne.fulfilled_at === null && ligne.notified_at === null);

    // ---------- 4. Doublon refuse ----------
    const doublon = await appel('POST', '/api/requests', { placeId: PLACE_ID }, cookieUser);
    verifie('doublon refuse (409)', doublon.status === 409 && doublon.corps.reason === 'deja_demande', `HTTP ${doublon.status} ${doublon.corps.reason || ''}`);
    verifie('le doublon ne cree pas de seconde ligne',
      (await c.query('SELECT COUNT(*)::int AS c FROM script_requests WHERE place_id = $1', [PLACE_ID])).rows[0].c === 1);

    const invalide = await appel('POST', '/api/requests', { placeId: 'pas-un-nombre' }, cookieUser);
    verifie('PlaceId non numerique refuse (400)', invalide.status === 400, `HTTP ${invalide.status}`);

    // ---------- 5. Classement public: le jeu apparait ----------
    const top = await appel('GET', '/api/requests/top');
    const entree = top.corps.games.find((g) => g.placeId === PLACE_ID);
    verifie('le jeu demande apparait dans le classement public', !!entree);
    verifie('compteur de demandes en attente renvoye', entree && entree.requests >= 1, entree ? String(entree.requests) : '');
    verifie('nom et icone du jeu renvoyes', entree && entree.name === NOM_JEU && !!entree.iconUrl);
    verifie('script pas encore disponible pour ce jeu', entree && entree.available === false);
    verifie('le classement n\'expose aucun identifiant Discord',
      !JSON.stringify(top.corps).includes(DISCORD_ID));

    // ---------- 6. Mes demandes (connexion requise) ----------
    const mineAnon = await appel('GET', '/api/requests/mine');
    verifie('mes demandes sans connexion refusees (401)', mineAnon.status === 401, `HTTP ${mineAnon.status}`);
    const mine = await appel('GET', '/api/requests/mine', undefined, cookieUser);
    verifie('mes demandes en attente renvoyees', mine.status === 200 && mine.corps.pending.some((d) => d.placeId === PLACE_ID));
    verifie('aucune demande servie a notifier pour l\'instant', Array.isArray(mine.corps.fulfilled) && mine.corps.fulfilled.length === 0);

    // ---------- 7. Publication du script -> retrait automatique ----------
    const version = (await c.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM script_versions')).rows[0].v;
    const versIns = await c.query(
      `INSERT INTO script_versions (version, note, place_id, original_enc, original_iv, original_hash)
       VALUES ($1, '', $2, 'test', 'test', 'test') RETURNING id`,
      [version, PLACE_ID]
    );
    await c.query(
      `INSERT INTO script_builds (version_id, version, place_id, content, build_type)
       VALUES ($1, $2, $3, '-- build de test', 'shims')`,
      [versIns.rows[0].id, version, PLACE_ID]
    );
    const tokenAdmin = cryptoService.randomToken(32);
    await c.query(
      `INSERT INTO admin_sessions (token_hash, discord_id, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')`,
      [cryptoService.hashToken(tokenAdmin), DISCORD_ID]
    );
    const publie = await appel('POST', '/api/admin/script/publish', { version }, `ks_admin=${tokenAdmin}`);
    verifie('publication du script acceptee (200)', publie.status === 200 && publie.corps.success === true, `HTTP ${publie.status}`);
    verifie('publication: demandes servies comptees', publie.corps.requestsFulfilled >= 1, String(publie.corps.requestsFulfilled));

    const servie = (await c.query(
      'SELECT status, fulfilled_at, notified_at FROM script_requests WHERE place_id = $1',
      [PLACE_ID]
    )).rows[0];
    verifie('demande passee a fulfilled avec fulfilled_at',
      servie && servie.status === 'fulfilled' && servie.fulfilled_at !== null);
    verifie('notified_at encore vide (popup a afficher une fois)', servie && servie.notified_at === null);

    const topApres = await appel('GET', '/api/requests/top');
    verifie('le jeu servi sort du classement des demandes',
      !topApres.corps.games.some((g) => g.placeId === PLACE_ID));

    const mineApres = await appel('GET', '/api/requests/mine', undefined, cookieUser);
    verifie('mes demandes servies signalees pour le popup',
      mineApres.corps.fulfilled.some((d) => d.placeId === PLACE_ID));
    verifie('plus aucune demande en attente pour ce jeu',
      !mineApres.corps.pending.some((d) => d.placeId === PLACE_ID));

    // ---------- 8. Popup vu une seule fois ----------
    const seen = await appel('POST', '/api/requests/seen', {}, cookieUser);
    verifie('marquage des demandes servies comme vues', seen.status === 200 && seen.corps.seen >= 1, `HTTP ${seen.status} ${seen.corps.seen}`);
    const mineVu = await appel('GET', '/api/requests/mine', undefined, cookieUser);
    verifie('le popup ne se represente pas (liste servie vide)', mineVu.corps.fulfilled.length === 0);
    const notifiee = (await c.query(
      'SELECT notified_at FROM script_requests WHERE place_id = $1',
      [PLACE_ID]
    )).rows[0];
    verifie('notified_at enregistre en base', notifiee && notifiee.notified_at !== null);

    // ---------- 9. Une demande servie ne bloque pas une nouvelle demande ----------
    const nouvelle = await appel('POST', '/api/requests', { placeId: PLACE_ID, note: 'mise a jour' }, cookieUser);
    verifie('nouvelle demande possible apres une demande servie (200)', nouvelle.status === 200, `HTTP ${nouvelle.status}`);
  } catch (e) {
    console.error('  ECHEC:', e.message);
    echecs++;
  } finally {
    arret();
    await nettoyage();
    await c.end().catch(() => {});
  }

  console.log(`\n  VERDICT: ${echecs === 0 ? 'les demandes de scripts se comportent comme prevu (publication = demandes servies)' : echecs + ' probleme(s)'}`);
  process.exit(echecs === 0 ? 0 : 1);
})().catch((e) => { console.error('  ECHEC:', e.message); process.exit(1); });
