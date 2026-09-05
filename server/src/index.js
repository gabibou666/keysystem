require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:'],
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

// OAuth Discord: redirect configure dans Discord = /admin/auth/callback
app.use('/admin', adminRoutes);

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
