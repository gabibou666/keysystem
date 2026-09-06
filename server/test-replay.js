// Test cible: le rejeu du status apres delivrance (usage unique du token)
require('dotenv').config();
const crypto = require('./src/services/crypto');
const pool = require('./src/db');
const discord = require('./src/services/discord');

const BASE = 'http://localhost:3000';

async function main() {
  const OWNER = '999000111';
  const puid = crypto.randomToken(32);
  await pool.query(
    `INSERT INTO ll_sessions (puid, tasks_required, ip, owner_discord_id, started_at)
     VALUES ($1, 1, '203.0.113.50', $2, now() - interval '3 minutes')`,
    [puid, OWNER]
  );
  const cookie = discord.signUserCookie(OWNER);

  // postback (complet)
  await fetch(`${BASE}/api/lootlabs/postback?click_id=${puid}&unique_id=rp-${Date.now()}`);

  // 1er status: doit delivrer
  const s1 = await fetch(`${BASE}/api/key/status?puid=${puid}`, {
    headers: { Cookie: `${discord.USER_COOKIE}=${cookie}` },
  });
  const d1 = await s1.json();
  console.log('1er status: HTTP ' + s1.status + ' status=' + d1.status + ' key=' + (d1.key ? 'OUI' : 'non'));

  // 2e status (rejeu): doit etre 409 already_claimed
  const s2 = await fetch(`${BASE}/api/key/status?puid=${puid}`, {
    headers: { Cookie: `${discord.USER_COOKIE}=${cookie}` },
  });
  const d2 = await s2.json();
  console.log('rejeu: HTTP ' + s2.status + ' status=' + d2.status + ' error=' + (d2.error || ''));

  // Et aussi: vol de session COMPLETE par un autre utilisateur (ordre correct du test)
  const other = discord.signUserCookie('888777666');
  const s3 = await fetch(`${BASE}/api/key/status?puid=${puid}`, {
    headers: { Cookie: `${discord.USER_COOKIE}=${other}` },
  });
  const d3 = await s3.json();
  console.log('autre utilisateur sur session completee: HTTP ' + s3.status + ' status=' + d3.status);

  const s4 = await fetch(`${BASE}/api/key/status?puid=${puid}`);
  console.log('sans cookie sur session completee: HTTP ' + s4.status);

  // nettoyage
  if (d1.key) await pool.query('DELETE FROM keys WHERE kid = $1', [d1.key.split('.')[0]]);
  await pool.query('DELETE FROM ll_sessions WHERE puid = $1', [puid]);
  await pool.query('DELETE FROM postbacks WHERE puid = $1', [puid]);
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
