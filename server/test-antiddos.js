// Test unitaire et fonctionnel du système Anti-DDoS
require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const http = require('http');
const antiddos = require('./src/services/antiddos');

async function runTests() {
  console.log('=== DEBUT DES TESTS ANTI-DDOS ===');

  const app = express();
  app.set('trust proxy', 1);
  app.use(antiddos.antiDdosMiddleware);
  app.get('/test', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Test 1: Whitelist 127.0.0.1 ne doit jamais être bloquée
    console.log('Test 1: Requêtes depuis localhost (whitelisted)...');
    for (let i = 0; i < 70; i++) {
      const res = await fetch(`${baseUrl}/test`);
      if (res.status !== 200) {
        throw new Error(`Localhost bloqué au rang ${i}: status ${res.status}`);
      }
    }
    console.log('  -> PASS: Localhost n\'est jamais bloqué');

    // Test 2: IP externe sous trafic normal (< 60 reqs / 10s)
    console.log('Test 2: IP externe avec trafic modéré (15 reqs)...');
    const ATTACKER_IP = '198.51.100.77';
    antiddos.unbanIP(ATTACKER_IP);

    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${baseUrl}/test`, {
        headers: { 'X-Forwarded-For': ATTACKER_IP },
      });
      if (res.status !== 200) {
        throw new Error(`Trafic normal rejeté au rang ${i}: status ${res.status}`);
      }
    }
    console.log('  -> PASS: Trafic normal accepté (HTTP 200)');

    // Test 3: Simulation de Flood DDoS (> 95 reqs en rafale)
    console.log('Test 3: Simulation d\'inondation DDoS en rafale (> 95 reqs)...');
    let softLimitHit = false;
    let ddosBlocked = false;
    let lastStatus = 0;

    for (let i = 16; i <= 105; i++) {
      const res = await fetch(`${baseUrl}/test`, {
        headers: {
          'X-Forwarded-For': ATTACKER_IP,
          'User-Agent': 'DDoS-Botnet-Simulation/1.0',
        },
      });
      lastStatus = res.status;
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        if (body.error && body.error.includes('Rate limit exceeded')) {
          softLimitHit = true;
        }
        if (body.error && body.error.includes('DDoS flood attempt detected')) {
          ddosBlocked = true;
          break;
        }
      }
    }

    if (!ddosBlocked) {
      throw new Error(`Le seuil DDoS n'a pas été déclenché! Dernier statut: ${lastStatus}`);
    }
    console.log('  -> PASS: Attaque DDoS interceptée avec succès (seuil franchi)');

    // Test 4: Vérification de la mise en quarantaine (Auto-Jail)
    console.log('Test 4: Vérification du blocage immédiat en prison (Auto-Jail)...');
    const jailedRes = await fetch(`${baseUrl}/test`, {
      headers: { 'X-Forwarded-For': ATTACKER_IP },
    });
    const jailedBody = await jailedRes.json().catch(() => ({}));
    const retryAfter = jailedRes.headers.get('retry-after');

    if (jailedRes.status !== 429 || !jailedBody.error?.includes('KeySystem Anti-DDoS')) {
      throw new Error(`L'IP devrait être en prison: status=${jailedRes.status}, body=${JSON.stringify(jailedBody)}`);
    }
    if (!retryAfter || parseInt(retryAfter, 10) < 60) {
      throw new Error(`En-tête Retry-After manquant ou incorrect: ${retryAfter}`);
    }
    console.log(`  -> PASS: IP fermement en prison (Retry-After: ${retryAfter}s)`);

    // Test 5: Vérification des statistiques
    const stats = antiddos.getStats();
    console.log('Test 5: Vérification des statistiques du service...');
    console.log('  Statistiques:', stats);
    if (stats.currentJailedCount < 1 || stats.totalBlockedAttacks < 1) {
      throw new Error('Statistiques anti-ddos invalides');
    }
    console.log('  -> PASS: Statistiques cohérentes');

    // Nettoyage
    antiddos.unbanIP(ATTACKER_IP);
    console.log('=== TOUS LES TESTS ANTI-DDOS SONT PASSES AVEC SUCCES ===');
  } finally {
    server.close();
  }
}

runTests().catch((e) => {
  console.error('ECHEC DU TEST:', e);
  process.exit(1);
});
