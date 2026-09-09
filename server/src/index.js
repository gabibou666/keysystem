require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const discordRoutes = require('./routes/discord');
const robuxRoutes = require('./routes/robux');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.highrevenueformat.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        frameSrc: ["'self'", 'https://www.highrevenueformat.com', 'https://*.highrevenueformat.com'],
        imgSrc: ["'self'", 'data:', 'https://tr.rbxcdn.com', 'https://t0.rbxcdn.com', 'https://t1.rbxcdn.com', 'https://t2.rbxcdn.com', 'https://t3.rbxcdn.com', 'https://t4.rbxcdn.com', 'https://t5.rbxcdn.com', 'https://t6.rbxcdn.com', 'https://t7.rbxcdn.com', 'https://www.highrevenueformat.com'],
        connectSrc: ["'self'", 'https://discord.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '2mb' }));
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

// Keepalive — empêche Render free tier de s'endormir
app.get('/api/keepalive', (req, res) => res.json({ ok: true, t: Date.now() }));

// Static front
const webDir = path.join(__dirname, '..', '..', 'web');
app.use(express.static(webDir, { extensions: ['html'] }));

// API
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/discord', discordRoutes.router);
app.use('/api/robux', robuxRoutes);

// OAuth Discord: redirect configure dans Discord = /admin/auth/callback
app.use('/admin', adminRoutes);

// Callback LootLabs: la page getkey.html gere le puid cote client
// Anti-bypass: le referer doit venir de l'infrastructure LootLabs (spoofable seul,
// mais couche supplementaire) — sinon redirection normale (l'experience legitime
// passe toujours par loot-link.com / links.lootlabs.gg).
app.get('/getkey/callback', (req, res) => {
  const ref = (req.headers.referer || '').toLowerCase();
  const fromLootlabs = ref.includes('loot-link.com') || ref.includes('lootlabs.gg');
  if (!fromLootlabs && process.env.NODE_ENV === 'production') {
    // Referer absent/etranger: on log pour audit, mais on laisse passer —
    // la vraie protection est le token serveur (un referer falsifie ne delivre rien).
    console.log('[getkey/callback] referer non-LootLabs:', req.headers.referer || '(none)');
  }
  res.sendFile(path.join(webDir, 'getkey.html'));
});

// Page paiement Robux
app.get('/robux/', (req, res) => {
  res.sendFile(path.join(webDir, 'robux.html'));
});

// /admin -> dashboard
app.get('/admin/', (req, res) => {
  res.sendFile(path.join(webDir, 'admin.html'));
});

app.use((err, req, res, next) => {
  console.error('[server]', err);
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
  ? process.env.PUBLIC_URL.replace(/\/$/, '') + '/api/stats/public'
  : null;

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

app.listen(PORT, () => {
  console.log(`[server] KeySystem en ligne sur le port ${PORT}`);
  console.log(`[server] PUBLIC_URL = ${process.env.PUBLIC_URL || '(non defini)'}`);
});
