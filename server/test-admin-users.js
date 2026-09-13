require('dotenv').config();
const http = require('http');
const express = require('express');
const pool = require('./src/db');
const auth = require('./src/admin/auth');
const adminRoutes = require('./src/routes/admin');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx !== -1) {
        cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      }
    });
  }
  req.cookies = cookies;
  next();
});
app.use('/api/admin', adminRoutes);

let server;
const PORT = 3105;
const BASE = `http://127.0.0.1:${PORT}`;

function check(label, ok) {
  if (ok) {
    console.log(`  -> PASS: ${label}`);
  } else {
    console.error(`  -> FAIL: ${label}`);
    process.exitCode = 1;
  }
}

async function main() {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log('=== TEST DU PANEL ADMIN : UTILISATEURS & RESET AD LIMIT ===\n');

  try {
    const adminIds = auth.getAdminIds();
    const testAdminId = adminIds[0] || '123456789012345678';

    // Crée une session admin valide
    const adminToken = await auth.createSession(testAdminId);
    const adminCookie = `ks_admin=${adminToken}`;

    // 1. Liste des utilisateurs
    const rUsers = await fetch(`${BASE}/api/admin/users`, {
      headers: { Cookie: adminCookie },
    });
    const dUsers = await rUsers.json();
    check('GET /api/admin/users renvoie la liste des utilisateurs (HTTP 200, success = true)', rUsers.status === 200 && dUsers.success === true && Array.isArray(dUsers.users));
    console.log(`     Total utilisateurs trouvés: ${dUsers.users.length}`);

    // 2. Recherche par pseudo
    const rSearch = await fetch(`${BASE}/api/admin/users?q=deary`, {
      headers: { Cookie: adminCookie },
    });
    const dSearch = await rSearch.json();
    check('Recherche par pseudo "?q=deary" filtre correctement', rSearch.status === 200 && dSearch.users.some(u => u.username.includes('deary')));

    const targetUser = dSearch.users.find(u => u.username.includes('deary'));
    if (targetUser) {
      console.log(`     Utilisateur cible: ${targetUser.username} (${targetUser.discord_id}), ads_last_12h avant = ${targetUser.ads_last_12h}`);

      // 3. Réinitialisation de la limite
      const rReset = await fetch(`${BASE}/api/admin/users/${targetUser.discord_id}/reset-limit`, {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      const dReset = await rReset.json();
      check('POST /api/admin/users/:discordId/reset-limit accepte (HTTP 200, success = true)', rReset.status === 200 && dReset.success === true);

      // 4. Vérification que le compteur est tombé à 0
      const rAfter = await fetch(`${BASE}/api/admin/users?q=${targetUser.discord_id}`, {
        headers: { Cookie: adminCookie },
      });
      const dAfter = await rAfter.json();
      const userAfter = dAfter.users.find(u => u.discord_id === targetUser.discord_id);
      check('Compteur ads_last_12h est bien retombé à 0', userAfter && userAfter.ads_last_12h === 0);
      console.log(`     Utilisateur ${userAfter.username}: ads_last_12h après = ${userAfter.ads_last_12h}`);
    }

    console.log('\n=== TOUS LES TESTS ADMIN SONT PASSES AVEC SUCCES ===');
  } catch (e) {
    console.error('Erreur test admin:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();
