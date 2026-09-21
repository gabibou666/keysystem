require('dotenv').config();

// Validation de configuration AVANT tout le reste: refuse de demarrer en
// production avec un secret manquant (voir src/config-check.js).
const { assertProdConfig, checkConfig } = require('./config-check');
assertProdConfig();

const express = require('express');
const helmet = require('helmet');
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const discordRoutes = require('./routes/discord');
const robuxRoutes = require('./routes/robux');
const pool = require('./db');
const { startPurgeScheduler } = require('./services/purge');
const { auditRecentSessions } = require('./services/lootlabs-verify');
const { notifyDiscord } = require('./services/notify');
const alerts = require('./services/alerts');

// Schedulers desactivables (utile pour lancer un serveur local de test sans
// declencher purge + audit + self-ping sur la base / le site de production).
const SCHEDULERS_ON = process.env.SCHEDULERS !== 'off';

const webDir = path.join(__dirname, '..', '..', 'web');

function startLootlabsAuditScheduler() {
  if (!process.env.LOOTLABS_API_KEY) {
    console.log('[audit-lootlabs] LOOTLABS_API_KEY non defini — audit automatique inactif');
    return;
  }
  // Premier audit apres 2 minutes de demarrage
  setTimeout(async () => {
    try {
      const res = await auditRecentSessions(notifyDiscord);
      if (res && res.checked > 0) {
        console.log(`[audit-lootlabs] Demarrage: ${res.checked} session(s) verifiee(s), ${res.verified} avec revenu, ${res.suspicious} suspecte(s)`);
      }
    } catch (e) {
      console.warn('[audit-lootlabs] echec demarrage:', e.message);
    }
  }, 2 * 60 * 1000).unref();

  // Audit recurrent — intervalle reglable, 6 h par defaut (AUDIT_INTERVAL_HOURS).
  // Chaque passage REVEILLE la base Neon: un intervalle court consomme du quota
  // sans rien apporter, l'audit n'etant qu'un filet de securite (le postback
  // valide deja le revenu en temps reel). Voir scripts/check-cost.js.
  const auditHours = Math.max(1, Number(process.env.AUDIT_INTERVAL_HOURS) || 6);
  setInterval(async () => {
    try {
      const res = await auditRecentSessions(notifyDiscord);
      if (res && res.checked > 0) {
        console.log(`[audit-lootlabs] Recurrent: ${res.checked} session(s) verifiee(s), ${res.verified} avec revenu, ${res.suspicious} suspecte(s)`);
      }
    } catch (e) {
      console.warn('[audit-lootlabs] echec recurrent:', e.message);
    }
  }, auditHours * 60 * 60 * 1000).unref();

  console.log(`[audit-lootlabs] Scheduler actif (toutes les ${auditHours} h)`);
}

// ============================================================================
// Version des assets: sert au cache-busting (style.css?v=xxxx).
// Recalculee a chaque demarrage a partir des fichiers reellement servis:
// modifier le CSS/JS change la version => les navigateurs rechargent, sans
// jamais avoir a renommer les fichiers ni a vider un cache CDN.
// ============================================================================
function listStaticFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listStaticFiles(full, acc);
    else if (!/\.html?$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

function computeAssetVersion() {
  const hash = nodeCrypto.createHash('sha1');
  try {
    for (const file of listStaticFiles(webDir).sort()) {
      const st = fs.statSync(file);
      hash.update(`${path.relative(webDir, file)}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  } catch (e) {
    console.warn('[assets] version partielle:', e.message);
  }
  return hash.digest('hex').slice(0, 12);
}

const ASSET_VERSION = computeAssetVersion();

// URL publique du site, utilisee pour canonical/Open Graph (placeholder __SITE__
// dans les pages). Fallback: la variable d'environnement PORT/URL Render.
const SITE_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ============================================================================
// Pages HTML: injection de la version d'assets (placeholder __V__) + en-tetes.
// Le HTML se revalide toujours (no-cache), les assets versionnes sont caches 1 an.
// ============================================================================
const htmlCache = new Map();

function serveHtml(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let rel = decodeURIComponent(req.path).replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel === '') rel = 'index';
  if (rel.startsWith('api/') || rel.startsWith('admin/auth')) return next(); // routes dynamiques
  if (path.extname(rel)) {
    if (!rel.endsWith('.html')) return next(); // asset -> express.static
  } else {
    rel += '.html'; // /getkey -> getkey.html, /privacy/ -> privacy.html
  }

  const abs = path.resolve(webDir, rel);
  if (!abs.startsWith(path.resolve(webDir) + path.sep)) return next(); // anti path traversal

  let st;
  try {
    st = fs.statSync(abs);
    if (!st.isFile()) return next();
  } catch {
    return next();
  }

  let html;
  const cached = htmlCache.get(abs);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    html = cached.html;
  } else {
    try {
      html = fs.readFileSync(abs, 'utf8');
    } catch {
      return next();
    }
    if (html.includes('__V__')) html = html.split('__V__').join(ASSET_VERSION);
    // __SITE__: URL publique reelle (canonical, Open Graph). Evite toute URL de
    // domaine codee en dur dans les pages (le domaine peut changer).
    if (html.includes('__SITE__')) html = html.split('__SITE__').join(SITE_URL);
    htmlCache.set(abs, { html, mtimeMs: st.mtimeMs });
  }

  res.set('Content-Type', 'text/html; charset=UTF-8');
  res.set('Cache-Control', 'no-cache, must-revalidate');
  // Pages d'administration / d'attente: jamais indexees.
  if (rel === 'admin.html' || rel === 'verify.html') {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  res.send(html);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Nombre de proxies de confiance (Render = 1). Rend configurable pour pouvoir
// corriger un mauvais reglage (IP client faussee => anti-DDoS inoperant) sans
// redeployer de code.
const TRUST_PROXY = parseInt(process.env.TRUST_PROXY || '1', 10);
app.set('trust proxy', Number.isFinite(TRUST_PROXY) ? TRUST_PROXY : 1);

// ===== PROTECTION ANTI-DDOS & AUTO-JAIL (Premier rempart d'interception) =====
const { antiDdosMiddleware } = require('./services/antiddos');
app.use(antiDdosMiddleware);

// ===== Filet de securite CSP =====
// Le durcissement (suppression de 'unsafe-inline') est volontairement reversible
// sans redeploiement: si un partenaire publicitaire injectait un jour un script
// inline, il suffit de mettre CSP_ALLOW_INLINE_SCRIPTS=1 dans les variables
// d'environnement Render pour restaurer l'ancien comportement en 10 secondes.
const ALLOW_INLINE_SCRIPTS = process.env.CSP_ALLOW_INLINE_SCRIPTS === '1';

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Plus de 'unsafe-inline' sur scriptSrc: tous les <script> inline ont
        // ete extraits dans web/app-*.js. Les attributs onclick= restent
        // autorises via script-src-attr (tolerance temporaire, documentee:
        // toute injection HTML est bloquee par l'echappement strict cote front).
        scriptSrc: ALLOW_INLINE_SCRIPTS
          ? ["'self'", "'unsafe-inline'", 'https://www.highrevenueformat.com']
          : ["'self'", 'https://www.highrevenueformat.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        // Violations remontees sur /api/csp-report (log + alerte Discord):
        // on detecte immediatement un partenaire qui aurait besoin d'une
        // exception, au lieu de le decouvrir en perdant du revenu.
        reportUri: ['/api/csp-report'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Les creatives publicitaires arrivent depuis des domaines CDN tournants
        // impossibles a lister: images/frames/tracking ouverts (aucun risque de
        // script via img/frame; la protection XSS reste sur scriptSrc).
        imgSrc: ['*'],
        frameSrc: ['*'],
        mediaSrc: ['*'],
        // Polices auto-hebergees (/fonts): plus aucun appel a Google Fonts
        // (conformite RGPD/CNIL + suppression d'une chaine bloquante).
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://discord.com', 'https://www.highrevenueformat.com', 'https://*.highrevenueformat.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

app.use(express.json({ limit: '2mb', type: ['application/json', 'application/csp-report', 'application/reports+json'] }));
app.use(express.urlencoded({ extended: true }));

// Cookie parser minimal (sans dependance)
app.use((req, res, next) => {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) {
        cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
  }
  req.cookies = cookies;
  next();
});

// ---------- Sondes SANS base de donnees ----------
// ATTENTION: ces routes ne doivent JAMAIS interroger la base. Neon gratuit met
// le calcul en veille apres 5 min d'inactivite: un ping frequent vers une route
// qui fait un SELECT reveille la base 24 h/24 (~182 CU-hours/mois pour un quota
// de 100) et epuise le quota vers le 16 du mois. Cibles officielles des
// moniteurs et des keep-alive (Render, GitHub Actions, UptimeRobot):
//   /api/keepalive (historique, utilise par le self-ping et GitHub Actions)
//   /ping          (nom public pour un moniteur externe)
// Garde-fou associe: npm run check -> scripts/check-cost.js
app.get('/api/keepalive', (req, res) => res.json({ ok: true, t: Date.now() }));
app.get('/ping', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, t: Date.now() }));

// ---------- POST /api/csp-report ----------
// Recoit les rapports de violation de la CSP (report-uri). Si un partenaire
// publicitaire tente d'injecter un script inline, on le voit ici (log + alerte
// Discord) au lieu de le decouvrir via une baisse de revenu inexplicable.
const cspAlertState = { lastAt: 0 };
app.post('/api/csp-report', (req, res) => {
  try {
    const raw = req.body || {};
    const report = raw['csp-report'] || raw.body || (Array.isArray(raw) ? raw[0] && raw[0].body : null) || {};
    const directive = report['violated-directive'] || report.violatedDirective || report['effective-directive'] || '(inconnue)';
    const blocked = report['blocked-uri'] || report.blockedURL || '(inconnu)';
    const page = report['document-uri'] || report.documentURL || '(inconnue)';
    console.warn(`[csp] ${directive} <- ${String(blocked).slice(0, 120)} (page ${String(page).slice(0, 120)})`);

    const now = Date.now();
    if (now - cspAlertState.lastAt > 10 * 60 * 1000) {
      cspAlertState.lastAt = now;
      // Le conseil depend de la directive ET de l'etat reel du serveur: envoyer
      // "active la valve" a quelqu'un qui l'a deja activee fait tourner en rond.
      const estScript = /script/i.test(directive);
      const dejaPermissif = /^(img-src|media-src|frame-src)$/i.test(directive.trim());
      let conseil;
      if (estScript && ALLOW_INLINE_SCRIPTS) {
        conseil =
          "La valve est DEJA active sur ce serveur (script-src contient 'unsafe-inline'): cette violation vient donc d'autre chose. Une variable Render ne reglera pas ce cas — autoriser le domaine bloque ci-dessus dans la directive concernee (src/index.js).";
      } else if (estScript) {
        conseil =
          'Script publicitaire ? definir CSP_ALLOW_INLINE_SCRIPTS=1 dans Render (valve de secours prevue pour ce cas). Apres enregistrement, Render redeploie: cette alerte doit disparaitre au demarrage suivant.';
      } else if (/connect-src/i.test(directive)) {
        conseil =
          "Ajouter l'origine bloquee a connectSrc dans src/index.js (avec les autres domaines publicitaires). Aucune variable Render ne modifie la CSP: elle est construite dans le code.";
      } else if (dejaPermissif) {
        conseil =
          'Cette directive est deja permissive (*): la ressource vient probablement d\'une page hors du site (iframe d\'annonceur) — verifier l\'URL bloquee ci-dessus avant de modifier quoi que ce soit.';
      } else {
        conseil =
          "Autoriser le domaine bloque dans la directive concernee (src/index.js), ou retirer la ressource. Les variables Render ne modifient pas la CSP.";
      }
      notifyDiscord({
        title: '🛡️ CSP : ressource bloquee',
        color: 'warn',
        description: `Directive : \`${directive}\`\nBloque : \`${String(blocked).slice(0, 120)}\`\nPage : ${String(page).slice(0, 120)}`,
        fields: [
          { name: 'Que faire ?', value: conseil },
          {
            name: 'Etat du serveur',
            value: `valve inline-scripts: ${ALLOW_INLINE_SCRIPTS ? 'ACTIVE' : 'inactive'} · assets ${ASSET_VERSION}`,
          },
        ],
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[csp] rapport illisible:', e.message);
  }
  res.status(204).end();
});

// ---------- /healthz : sonde PROFONDE, a cout maitrise ----------
// Elle verifie la base, donc elle la REVEILLE. Pour ne pas consommer le quota
// Neon gratuit (100 CU-hours/mois, veille apres 5 min), la requete SQL n'est
// faite qu'une fois par HEALTHZ_DEEP_TTL_MIN (60 min par defaut) meme si un
// moniteur appelle la route toutes les minutes: les appels suivants repondent
// depuis le cache. Les moniteurs FREQUENTS visent /ping (aucune requete SQL).
//   ?deep=1 -> sonde forcee (diagnostic ponctuel)
// Si la base est en panne, le delai retombe a 60 s pour detecter la reprise.
// Delai par defaut volontairement large (6 h): un plan gratuit ne peut pas se
// permettre de sonder la base toutes les heures (chaque reveil coute ~5 min de
// calcul, soit ~15 CU-hours/mois pour une sonde horaire, sur 100 disponibles).
// La detection rapide d'une panne ne vient pas de la sonde mais des alertes
// evementielles (services/alerts.js): cout nul tant que tout va bien.
const HEALTHZ_DEEP_TTL_MS = Math.max(5, Number(process.env.HEALTHZ_DEEP_TTL_MIN) || 360) * 60 * 1000;
const healthzState = { checkedAt: 0, ok: false, latencyMs: null, error: null };

app.get('/healthz', async (req, res) => {
  const forced = req.query.deep === '1';
  const age = Date.now() - healthzState.checkedAt;
  const ttl = healthzState.ok ? HEALTHZ_DEEP_TTL_MS : 60 * 1000;

  if (!forced && healthzState.checkedAt && age < ttl) {
    return res.status(healthzState.ok ? 200 : 503).json({
      ok: healthzState.ok,
      db: healthzState.ok ? 'up' : 'down',
      cached: true,
      checkedAgeSec: Math.round(age / 1000),
      nextDeepCheckInSec: Math.round((ttl - age) / 1000),
      assets: ASSET_VERSION,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      ...(healthzState.error ? { error: healthzState.error } : {}),
    });
  }

  const started = Date.now();
  try {
    await pool.query('SELECT 1');
    Object.assign(healthzState, { checkedAt: Date.now(), ok: true, latencyMs: Date.now() - started, error: null });
  } catch (e) {
    Object.assign(healthzState, { checkedAt: Date.now(), ok: false, latencyMs: null, error: e.message });
    alerts.report(new Error(`base injoignable: ${e.message}`), { where: 'healthz', route: '/healthz' }).catch(() => {});
  }
  res.status(healthzState.ok ? 200 : 503).json({
    ok: healthzState.ok,
    db: healthzState.ok ? 'up' : 'down',
    cached: false,
    node: process.version,
    ...(healthzState.latencyMs !== null ? { latencyMs: healthzState.latencyMs } : {}),
    ...(healthzState.error ? { error: healthzState.error } : {}),
    assets: ASSET_VERSION,
    uptimeSec: Math.round(process.uptime()),
  });
});

// robots.txt / sitemap.xml: servis avec l'URL publique reelle (placeholder
// __SITE__) pour ne jamais dependre d'un domaine code en dur.
for (const [route, file, type] of [
  ['/robots.txt', 'robots.txt', 'text/plain; charset=utf-8'],
  ['/sitemap.xml', 'sitemap.xml', 'application/xml; charset=utf-8'],
]) {
  app.get(route, (req, res) => {
    try {
      const body = fs
        .readFileSync(path.join(webDir, file), 'utf8')
        .split('__SITE__')
        .join(SITE_URL);
      res.set('Content-Type', type);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(body);
    } catch {
      res.status(404).type('text/plain').send('Not found');
    }
  });
}

// ===== Front statique =====
// 1) Pages HTML (versionnees + no-cache)
app.use(serveHtml);

// 2) Polices auto-hebergees: cache tres long
app.use(
  '/fonts',
  express.static(path.join(webDir, 'fonts'), { maxAge: '365d', immutable: true })
);

// 3) Assets versionnes (style.css?v=xxxx, app-*.js?v=xxxx...): cache 1 an
app.use(
  express.static(webDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (/\.(css|js|woff2|png|svg|ico|jpg|webp)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);

// API
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/discord', discordRoutes.router);
app.use('/api/robux', robuxRoutes);

// OAuth Discord: redirect configure dans Discord = /admin/auth/callback
app.use('/admin', adminRoutes);

// Retour LootLabs: sert la page getkey (versionnee) en conservant l'URL du
// navigateur intacte (le front lit location.search).
// Anti-bypass: le referer doit venir de l'infrastructure LootLabs (spoofable seul,
// mais couche supplementaire) — sinon on log pour audit, la vraie protection
// reste le token serveur (un referer falsifie ne delivre rien).
app.get('/getkey/callback', (req, res, next) => {
  const ref = (req.headers.referer || '').toLowerCase();
  if (!ref.includes('loot-link.com') && !ref.includes('lootlabs.gg') && process.env.NODE_ENV === 'production') {
    console.log('[getkey/callback] referer non-LootLabs:', req.headers.referer || '(none)');
  }
  req.url = '/getkey.html';
  serveHtml(req, res, next);
});

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.use((err, req, res, next) => {
  console.error('[server]', err);
  // Alerte Discord (anti-inondation) sur les 500 non geres: sans cela, une panne
  // de la base ne se voit que par les utilisateurs ou dans les logs Render.
  alerts.report(err, { where: 'express', route: req.originalUrl }).catch(() => {});
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Erreur interne' });
});

// ===== SELF-PING ANTI-SOMMEIL (Render free: spin-down apres 15 min sans trafic) =====
// Le serveur se ping lui-meme via son URL publique toutes les 5 minutes:
// la requete sort sur internet et revient par l'edge Render = trafic ENTRANT
// => le timer de mise en veille est remis a zero en perpetuite.
// Tant que le process tourne, le service ne peut plus jamais s'endormir.
// (Le GitHub Actions keepalive reste en filet de securite pour REVEILLER le service
//  si Render le redemarre/redeploie: le self-ping ne peut pas traverser un redemarrage.)
const SELF_PING_URL = process.env.PUBLIC_URL
  ? process.env.PUBLIC_URL.replace(/\/$/, '') + '/api/keepalive'
  : null;

// Alertes d'erreurs non gerees -> Discord (cout nul tant que tout va bien).
alerts.install();

app.listen(PORT, () => {
  console.log(`[server] KeySystem en ligne sur le port ${PORT}`);
  console.log(`[server] PUBLIC_URL = ${process.env.PUBLIC_URL || '(non defini)'}`);
  console.log(`[server] assets=${ASSET_VERSION} · trust proxy=${app.get('trust proxy')}`);

  const { warnings } = checkConfig();
  if (warnings.length && process.env.NODE_ENV === 'production') {
    notifyDiscord({
      title: '⚠️ Configuration a corriger',
      color: 'warn',
      description: warnings.map((w) => `• ${w}`).join('\n'),
    }).catch(() => {});
  }

  if (!SCHEDULERS_ON) {
    console.log('[schedulers] desactives (SCHEDULERS=off)');
    return;
  }

  startPurgeScheduler();
  startLootlabsAuditScheduler();

  if (SELF_PING_URL && !SELF_PING_URL.includes('localhost') && !SELF_PING_URL.includes('127.0.0.1')) {
    setInterval(
      async () => {
        try {
          const res = await fetch(SELF_PING_URL, { signal: AbortSignal.timeout(20000) });
          console.log(`[self-ping] ${new Date().toISOString()} -> HTTP ${res.status}`);
        } catch (e) {
          console.log(`[self-ping] echec (${e.message}) — le filet GitHub Actions prendra le relais`);
        }
      },
      5 * 60 * 1000
    ).unref();
    console.log(`[self-ping] anti-sleep actif vers ${SELF_PING_URL} (toutes les 5 min)`);
  } else {
    console.log('[self-ping] desactive (PUBLIC_URL local ou non defini)');
  }
});

module.exports = app;
