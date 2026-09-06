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
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:', 'https://tr.rbxcdn.com', 'https://t0.rbxcdn.com', 'https://t1.rbxcdn.com', 'https://t2.rbxcdn.com', 'https://t3.rbxcdn.com', 'https://t4.rbxcdn.com', 'https://t5.rbxcdn.com', 'https://t6.rbxcdn.com', 'https://t7.rbxcdn.com'],
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

app.listen(PORT, () => {
  console.log(`[server] KeySystem en ligne sur le port ${PORT}`);
  console.log(`[server] PUBLIC_URL = ${process.env.PUBLIC_URL || '(non defini)'}`);
});
