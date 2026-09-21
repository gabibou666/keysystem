/* Verifie la FABRIQUE DE PROMPT du panneau d'administration (aucun appel a un
   modele, donc aucun cout) et l'enregistrement du code colle :
     1) la fabrique de prompt ne fait AUCUN appel reseau (https.request,
        http.request et fetch sont neutralises dans un process enfant) et le
        prompt contient TOUTES les contraintes qui rendent le script generable
        sans erreur, pour plusieurs descriptions et ID de jeu differents ;
     2) POST /api/admin/generate-script renvoie le prompt construit localement
        (meme entree { brief, placeId }) et N'ECRIT RIEN en base ;
     3) POST /api/admin/script-from-text est REFUSEE sans droits d'administration
        et ne cree rien ;
     4) un code valide est enregistre en BROUILLON (published = false), chiffre
        comme les autres versions, et se relit a l'identique apres dechiffrement ;
     5) un code invalide est REFUSE et RIEN n'est enregistre (message du parseur
        renvoye tel quel) ;
     6) les balises markdown sont retirees AVANT le controle de syntaxe.

   Le serveur de test est demarre avec AI_API_KEY et AI_BASE_URL VIDES: si une
   route essayait encore de joindre un modele, elle echouerait au lieu de
   renvoyer un prompt — le succes des routes prouve donc le flux local.
   Le serveur est demarre par ce test lui-meme, sur un port dedie.
   Sans DATABASE_URL (integration continue), le test s'annonce et se saute.
   Regle de fond: ce test n'affiche JAMAIS de secret et nettoie ses lignes. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const RACINE = __dirname;
require(path.join(RACINE, 'node_modules', 'dotenv')).config({ path: path.join(RACINE, '.env') });

// Le serveur et le test doivent signer les cookies avec le MEME secret. S'il est
// absent (dev), on en fixe un pour ce process: la valeur n'est jamais affichee.
if (!process.env.HMAC_SECRET) process.env.HMAC_SECRET = nodeCrypto.randomBytes(32).toString('hex');

const PORT = 3202;
const BASE = `http://127.0.0.1:${PORT}`;
const DISCORD_ID = '909000000000000002'; // administrateur de test (compte fictif)
const BRIEF = 'panneau de test avec une section Farm et un bouton de fermeture';

let echecs = 0;
function verifie(intitule, condition, detail) {
  console.log(`${condition ? '  OK  ' : '  ECHEC'} ${intitule}${detail ? ' -> ' + detail : ''}`);
  if (!condition) echecs++;
}

// Script Luau minimal mais complet: compile en Lua 5.1 et contient les elements
// attendus d'un script genere (ScreenGui, TweenService, task.wait, :Destroy).
const CODE_VALIDE = `-- [test] script complet minimal (aucun appel reseau)
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")
local joueur = Players.LocalPlayer
local gui = Instance.new("ScreenGui")
gui.Name = "KSTestGui"
pcall(function()
  gui.Parent = joueur:WaitForChild("PlayerGui")
end)
local cadre = Instance.new("Frame")
cadre.Parent = gui
cadre.BackgroundColor3 = Color3.fromRGB(8, 7, 12)
local bouton = Instance.new("TextButton")
bouton.Parent = cadre
bouton.Text = "Fermer"
bouton.MouseButton1Click:Connect(function()
  TweenService:Create(cadre, TweenInfo.new(0.2), { BackgroundTransparency = 1 }):Play()
  task.wait(0.2)
  pcall(function()
    gui:Destroy()
  end)
end)`;

// `if ... then` sans `end`: erreur de syntaxe reelle pour luaparse.
const CODE_CASSE = `-- [test] script volontairement casse (il manque le end)
local gui = Instance.new("ScreenGui")
if gui then
  gui.Name = "KSTestGui"
`;

// Reponse d'IA entouree de balises markdown: doit etre nettoyee avant controle.
const CODE_ENTOURE = '```lua\n' + CODE_VALIDE + '\n```\n';

// Contraintes qui doivent figurer dans le prompt, avec la raison de chacune.
// Une contrainte qui disparait = un script casse chez l'utilisateur: c'est
// exactement ce que ce test doit empecher.
const CONTRAINTES = [
  ['code source uniquement, sans explication', /THE SOURCE CODE ONLY/],
  ['interdiction des balises markdown', /markdown code fence/],
  ['compatibilite Lua 5.1 annoncee', /Lua 5\.1/],
  ['interdiction de +=', /\+=/],
  ['interdiction des type annotations', /type annotations/],
  ['interdiction de continue', /no continue/],
  ['interdiction de goto', /no goto/],
  ['ScreenGui', /ScreenGui/],
  ['parentage au PlayerGui', /PlayerGui/],
  ['cadre principal deplacable', /DRAGGABLE/],
  ['deplacement implemente (UserInputService/InputChanged)', /UserInputService|InputChanged/],
  ['toggle buttons', /toggle buttons/i],
  ['sections titrees', /SECTIONS/],
  ['TweenService', /TweenService/],
  ['palette noir (#08070c, #12101a)', /#08070c[\s\S]*#12101a/],
  ['accents violets (#8b5cf6, #c084fc, #a78bfa)', /#8b5cf6[\s\S]*#c084fc[\s\S]*#a78bfa/],
  ['fermeture propre :Destroy()', /:Destroy\(\)/],
  ['task.wait et task.spawn', /task\.wait[\s\S]*task\.spawn/],
  ['pcall autour des appels fragiles', /pcall/],
  ['interdiction de require(id) tiers', /require\(id\)/],
  ['interdiction de loadstring distant', /loadstring[\s\S]{0,80}remote/],
  ['code directly executable', /directly executable/i],
  ['aucun placeholder ni TODO', /No placeholder[\s\S]{0,120}TODO/],
];

let PLACE_ID = 0;

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  (saute: DATABASE_URL absent de cet environnement)');
    process.exit(0);
  }

  const { Client } = require(path.join(RACINE, 'node_modules', 'pg'));
  const { sslOptions, urlSansSslmode } = require(path.join(RACINE, 'src', 'db-ssl'));
  const cryptoService = require(path.join(RACINE, 'src', 'services', 'crypto'));
  const aiService = require(path.join(RACINE, 'src', 'services', 'ai'));

  const c = new Client({
    connectionString: urlSansSslmode(process.env.DATABASE_URL),
    ssl: sslOptions(process.env.DATABASE_URL),
  });
  await c.connect();

  const table = await c.query(
    "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='script_versions'"
  );
  if (!table.rows.length) {
    await c.end();
    console.error('  ECHEC: table script_versions absente — appliquer db/schema.sql (npm run migrate)');
    process.exit(1);
  }

  // PlaceId de test: aleatoire et 9 chiffres, jamais un jeu reel.
  // script_requests est interrogee si la table existe (migration d'un autre
  // chantier): ce test ne doit pas en dependre.
  let aTableRequetes = true;
  try {
    await c.query('SELECT 1 FROM script_requests LIMIT 1');
  } catch (_) {
    aTableRequetes = false;
  }
  for (let essai = 0; essai < 10 && !PLACE_ID; essai++) {
    const candidat = 900000000 + Math.floor(Math.random() * 99999999);
    const sql =
      `SELECT 1 FROM game_info WHERE place_id = $1` +
      (aTableRequetes ? `\n UNION ALL SELECT 1 FROM script_requests WHERE place_id = $1` : '') +
      `\n UNION ALL SELECT 1 FROM script_builds WHERE place_id = $1
        UNION ALL SELECT 1 FROM script_versions WHERE place_id = $1`;
    const occupe = await c.query(sql, [candidat]);
    if (!occupe.rows.length) PLACE_ID = candidat;
  }
  if (!PLACE_ID) {
    await c.end();
    console.error('  ECHEC: aucun PlaceId de test libre trouve en base');
    process.exit(1);
  }

  const idsCrees = [];
  const nettoyage = async () => {
    try {
      if (idsCrees.length) {
        await c.query('DELETE FROM ai_patches WHERE build_id IN (SELECT id FROM script_builds WHERE version_id = ANY($1::int[]))', [idsCrees]);
        await c.query('DELETE FROM script_builds WHERE version_id = ANY($1::int[])', [idsCrees]);
        await c.query('DELETE FROM script_versions WHERE id = ANY($1::int[])', [idsCrees]);
      }
      await c.query('DELETE FROM script_versions WHERE place_id = $1', [PLACE_ID]);
      await c.query('DELETE FROM admin_sessions WHERE discord_id = $1', [DISCORD_ID]);
    } catch (e) {
      console.error('  (nettoyage partiel:', e.message + ')');
    }
  };
  await nettoyage();

  // Dossier de travail du test (sonde reseau + fixtures).
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-prompt-'));

  // Derniere version creee, apres un appel donne.
  const versionsApres = async (idMax) =>
    (await c.query(
      'SELECT id, version, note, place_id, published, published_at, original_hash FROM script_versions WHERE id > $1 ORDER BY id',
      [idMax]
    )).rows;
  const maxId = async () =>
    parseInt((await c.query('SELECT COALESCE(MAX(id), 0) AS m FROM script_versions')).rows[0].m, 10);

  try {
    // ---------- 1. La fabrique de prompt ne touche PAS au reseau ----------
    // La sonde s'execute dans un process ENFANT: on y remplace https.request,
    // http.request, https.get, http.get et fetch par des fonctions qui
    // enregistrent l'appel puis echouent. Si buildScriptPrompt tentait la
    // moindre connexion, la sonde leverait et le test echouerait ici.
    const casPrompt = [
      { brief: 'panneau de farm avec une section Recolte et un bouton de fermeture', placeId: PLACE_ID },
      { brief: 'menu de teleportation vers cinq zones avec un interrupteur par zone', placeId: 5551234 },
      { brief: 'interface de personnalisation : vitesse, saut et couleur du personnage', placeId: null },
    ];
    const cheminSonde = path.join(dossier, 'sonde-prompt.js');
    fs.writeFileSync(
      cheminSonde,
      `'use strict';
const appelsReseau = [];
const interdit = (nom) => () => { appelsReseau.push(nom); throw new Error('appel reseau interdit: ' + nom); };
const https = require('https');
const http = require('http');
https.request = interdit('https.request');
http.request = interdit('http.request');
https.get = interdit('https.get');
http.get = interdit('http.get');
globalThis.fetch = interdit('fetch');
const ai = require(${JSON.stringify(path.join(RACINE, 'src', 'services', 'ai').replace(/\\/g, '/'))});
const cas = ${JSON.stringify(casPrompt)};
const sorties = cas.map((x) => ({
  brief: x.brief,
  placeId: x.placeId,
  prompt: ai.buildScriptPrompt({ brief: x.brief, placeId: x.placeId }),
}));
process.stdout.write(JSON.stringify({ appelsReseau, sorties }));
`
    );

    let sonde = null;
    try {
      const brut = execFileSync(process.execPath, [cheminSonde], { encoding: 'utf8', timeout: 30000 });
      sonde = JSON.parse(brut);
    } catch (e) {
      verifie('la sonde de la fabrique de prompt s\'execute', false, String(e.message).slice(0, 120));
    }

    if (sonde) {
      verifie('la fabrique de prompt ne fait AUCUN appel reseau (https/http/fetch neutralises)',
        Array.isArray(sonde.appelsReseau) && sonde.appelsReseau.length === 0,
        `${sonde.appelsReseau.length} appel(s)`);
      verifie('un prompt est construit pour chaque description', sonde.sorties.length === casPrompt.length,
        `${sonde.sorties.length}/${casPrompt.length}`);

      // Contraintes: on liste TOUTES celles qui manquent, pas seulement la premiere.
      const manquantes = [];
      for (const sortie of sonde.sorties) {
        for (const [nom, motif] of CONTRAINTES) {
          if (!motif.test(sortie.prompt)) manquantes.push(`${nom} [${sortie.brief.slice(0, 24)}...]`);
        }
      }
      verifie(`les ${CONTRAINTES.length} contraintes cles sont dans chaque prompt`,
        manquantes.length === 0, manquantes.slice(0, 4).join(' | '));

      // La description saisie est bien integree, telle quelle.
      for (const [i, sortie] of sonde.sorties.entries()) {
        verifie(`description n°${i + 1} integree au prompt`, sortie.prompt.includes(sortie.brief),
          sortie.brief.slice(0, 40));
      }

      // L'ID de jeu est un contexte: present quand il est fourni, absent sinon.
      verifie('ID de jeu present dans le prompt quand il est fourni',
        sonde.sorties[0].prompt.includes(String(PLACE_ID)) && sonde.sorties[1].prompt.includes('5551234'));
      verifie('aucune section ID de jeu quand il est omis',
        !/TARGET GAME ID/.test(sonde.sorties[2].prompt));
      verifie('descriptions differentes -> prompts differents',
        new Set(sonde.sorties.map((s) => s.prompt)).size === sonde.sorties.length);
    }

    // Le service expose toujours la validation locale utilisee par la route.
    const controleLocal = aiService.verifierSyntaxe(CODE_VALIDE);
    verifie('verifierSyntaxe accepte le code de reference', controleLocal.ok === true, controleLocal.message);
    verifie('verifierSyntaxe refuse le code casse', aiService.verifierSyntaxe(CODE_CASSE).ok === false);
    verifie('nettoyerCode retire les balises markdown', aiService.nettoyerCode(CODE_ENTOURE) === CODE_VALIDE);

    // ---------- 2. Serveur de test (aucune cle IA: tout appel echouerait) ----------
    const serveur = spawn(process.execPath, ['src/index.js'], {
      cwd: RACINE,
      env: {
        ...process.env,
        PORT: String(PORT),
        SCHEDULERS: 'off',
        PUBLIC_URL: '',
        AI_API_KEY: '',   // filet de securite: aucun appel payant possible
        AI_BASE_URL: '',
      },
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
        signal: AbortSignal.timeout(60000),
      });
      return { status: r.status, corps: await r.json().catch(() => ({})) };
    };

    if (!(await attendre())) {
      console.error('  ECHEC: le serveur n\'a pas repondu sur /ping');
      arret();
      process.exit(1);
    }

    const tokenAdmin = cryptoService.randomToken(32);
    await c.query(
      `INSERT INTO admin_sessions (token_hash, discord_id, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')`,
      [cryptoService.hashToken(tokenAdmin), DISCORD_ID]
    );
    const cookieAdmin = `ks_admin=${tokenAdmin}`;

    // ---------- 3. Construction du prompt: droits d'administration exiges ----------
    const avant3 = await maxId();
    const anonyme = await appel('POST', '/api/admin/generate-script', { brief: BRIEF, placeId: PLACE_ID });
    verifie('construction du prompt refusee sans session admin (401)', anonyme.status === 401, `HTTP ${anonyme.status}`);
    verifie('aucun prompt renvoye a un appel anonyme', anonyme.corps.ok !== true && !anonyme.corps.prompt);
    verifie('aucune version creee par un appel refuse', (await versionsApres(avant3)).length === 0);

    // Description trop courte: refusee avant toute construction.
    const court = await appel('POST', '/api/admin/generate-script', { brief: 'court' }, cookieAdmin);
    verifie('description trop courte refusee (400)', court.status === 400 && court.corps.ok === false, `HTTP ${court.status}`);

    // Prompt construit localement, sans rien ecrire en base.
    const fabrique = await appel('POST', '/api/admin/generate-script', { brief: BRIEF, placeId: PLACE_ID }, cookieAdmin);
    verifie('prompt renvoye par la fabrique (200, ok = true)',
      fabrique.status === 200 && fabrique.corps.ok === true, `HTTP ${fabrique.status} ${fabrique.corps.error || ''}`);
    verifie('le prompt contient la description et l\'ID de jeu',
      typeof fabrique.corps.prompt === 'string' &&
        fabrique.corps.prompt.includes(BRIEF) &&
        fabrique.corps.prompt.includes(String(PLACE_ID)));
    verifie('taille du prompt annoncee = octets reels',
      fabrique.corps.tailleOctets === Buffer.byteLength(fabrique.corps.prompt, 'utf8'),
      `${fabrique.corps.tailleOctets} octets`);
    verifie('la fabrique de prompt N\'ECRIT RIEN en base (aucune version creee)',
      (await versionsApres(avant3)).length === 0);

    const sansId = await appel('POST', '/api/admin/generate-script', { brief: BRIEF }, cookieAdmin);
    verifie('prompt sans ID de jeu: aucune section ID dans le texte',
      sansId.status === 200 && sansId.corps.ok === true && !/TARGET GAME ID/.test(sansId.corps.prompt));

    // ---------- 4. Code colle: droits d'administration exiges ----------
    const avant4 = await maxId();
    const colleAnonyme = await appel('POST', '/api/admin/script-from-text', { code: CODE_VALIDE, placeId: PLACE_ID });
    verifie('enregistrement du code colle refuse sans session admin (401)',
      colleAnonyme.status === 401, `HTTP ${colleAnonyme.status}`);
    verifie('aucune version creee pour un appel anonyme', (await versionsApres(avant4)).length === 0);

    const vide = await appel('POST', '/api/admin/script-from-text', { code: '   ' }, cookieAdmin);
    verifie('code vide refuse (400)', vide.status === 400 && vide.corps.ok === false, `HTTP ${vide.status}`);
    verifie('aucune version creee pour un code vide', (await versionsApres(avant4)).length === 0);

    // ---------- 5. Code invalide: refuse, RIEN n'est enregistre ----------
    const casse = await appel('POST', '/api/admin/script-from-text', { code: CODE_CASSE, placeId: PLACE_ID }, cookieAdmin);
    verifie('code qui ne compile pas refuse (422, ok = false)',
      casse.status === 422 && casse.corps.ok === false, `HTTP ${casse.status}`);
    verifie('le message du parseur est renvoye tel quel',
      typeof casse.corps.error === 'string' && /end/i.test(casse.corps.error),
      String(casse.corps.error).slice(0, 90));
    verifie('aucun identifiant de version renvoye pour un code invalide', casse.corps.versionId === undefined);
    verifie('AUCUNE version enregistree pour un code qui ne compile pas', (await versionsApres(avant4)).length === 0);

    // ---------- 6. Code valide: brouillon chiffre, relu a l'identique ----------
    const valide = await appel(
      'POST',
      '/api/admin/script-from-text',
      { code: CODE_VALIDE, brief: BRIEF, placeId: PLACE_ID },
      cookieAdmin
    );
    verifie('code valide accepte (200, ok = true)',
      valide.status === 200 && valide.corps.ok === true, `HTTP ${valide.status} ${valide.corps.error || ''}`);
    verifie('aucune balise markdown a nettoyer sur un code deja propre', valide.corps.nettoye === false);
    verifie('resume du script renvoye', typeof valide.corps.resume === 'string' && valide.corps.resume.length > 0,
      valide.corps.resume);

    const lignes6 = await versionsApres(avant4);
    verifie('une seule version creee en base', lignes6.length === 1, `${lignes6.length} ligne(s)`);
    const v6 = lignes6[0] || {};
    if (v6.id) idsCrees.push(v6.id);
    verifie('version enregistree en BROUILLON (published = false, published_at vide)',
      v6.published === false && v6.published_at === null);
    verifie('PlaceId transmis a la version', v6.place_id != null && parseInt(v6.place_id, 10) === PLACE_ID, String(v6.place_id));
    verifie('note tracee (origine IA et description)',
      typeof v6.note === 'string' && v6.note.startsWith('[IA]') && v6.note.includes('Farm'), String(v6.note).slice(0, 50));
    verifie('aucun build cree (brouillon non publie, rien n\'est servi)',
      (await c.query('SELECT COUNT(*)::int AS c FROM script_builds WHERE version_id = $1', [v6.id])).rows[0].c === 0,
      `version = ${valide.corps.version}`);

    const relu = await appel('GET', `/api/admin/script/original/${valide.corps.version}`, undefined, cookieAdmin);
    verifie('version relisible par l\'editeur admin (200)', relu.status === 200 && relu.corps.success === true, `HTTP ${relu.status}`);
    verifie('le code dechiffre est IDENTIQUE au code colle', relu.corps.source === CODE_VALIDE);

    const enBase = (await c.query('SELECT original_enc, original_iv, original_hash FROM script_versions WHERE id = $1', [v6.id])).rows[0];
    verifie('le source est chiffre en base (jamais en clair)',
      enBase.original_enc !== CODE_VALIDE && enBase.original_iv.length > 0 && enBase.original_hash.length === 64);
    verifie('original_hash = sha256 du source en clair', enBase.original_hash === cryptoService.sha256(CODE_VALIDE));

    // ---------- 7. Balises markdown retirees avant controle ----------
    const avant7 = await maxId();
    const balises = await appel(
      'POST',
      '/api/admin/script-from-text',
      { code: CODE_ENTOURE, brief: BRIEF, placeId: PLACE_ID },
      cookieAdmin
    );
    verifie('reponse entouree de balises markdown acceptee apres nettoyage',
      balises.status === 200 && balises.corps.ok === true, `HTTP ${balises.status} ${balises.corps.error || ''}`);
    verifie('le nettoyage est signale dans la reponse', balises.corps.nettoye === true);
    const lignes7 = await versionsApres(avant7);
    if (lignes7[0]) idsCrees.push(lignes7[0].id);
    const relu7 = await appel('GET', `/api/admin/script/original/${balises.corps.version}`, undefined, cookieAdmin);
    verifie('aucune balise markdown ni texte parasite dans le code enregistre',
      relu7.corps.source === CODE_VALIDE && !/```/.test(relu7.corps.source));

    // ---------- 8. Un brouillon n'est jamais publie automatiquement ----------
    const publiees = await c.query(
      'SELECT COUNT(*)::int AS c FROM script_versions WHERE published = true AND place_id = $1',
      [PLACE_ID]
    );
    verifie('aucune publication automatique pour le jeu de test', publiees.rows[0].c === 0);

    arret();
  } catch (e) {
    console.error('  ECHEC:', e.message);
    echecs++;
  } finally {
    await nettoyage();
    await c.end().catch(() => {});
    try { fs.rmSync(dossier, { recursive: true, force: true }); } catch (_) { /* deja nettoye */ }
  }

  console.log(`\n  VERDICT: ${echecs === 0 ? 'la fabrique de prompt est locale (aucun appel a un modele) et le code colle n\'est enregistre que s\'il compile' : echecs + ' probleme(s)'}`);
  process.exit(echecs === 0 ? 0 : 1);
})().catch((e) => { console.error('  ECHEC:', e.message); process.exit(1); });
