// Session admin via Discord OAuth2 - allowlist stricte d'IDs
const crypto = require('../services/crypto');
const pool = require('../db');

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

function getAdminIds() {
  return (process.env.ADMIN_DISCORD_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getLoginUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord token exchange ${res.status}`);
  return res.json();
}

async function fetchDiscordUser(accessToken) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord user fetch ${res.status}`);
  return res.json();
}

async function createSession(discordId) {
  const token = crypto.randomToken(32);
  const tokenHash = crypto.hashToken(token);
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, discord_id, expires_at) VALUES ($1, $2, now() + interval '24 hours')`,
    [tokenHash, discordId]
  );
  return token;
}

async function getSession(req) {
  const token = (req.cookies && req.cookies.ks_admin) || null;
  if (!token) return null;
  const tokenHash = crypto.hashToken(token);
  const { rows } = await pool.query(
    'SELECT * FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()',
    [tokenHash]
  );
  return rows[0] || null;
}

async function destroySession(req) {
  const token = (req.cookies && req.cookies.ks_admin) || null;
  if (!token) return;
  await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [crypto.hashToken(token)]);
}

module.exports = {
  getAdminIds,
  getLoginUrl,
  exchangeCode,
  fetchDiscordUser,
  createSession,
  getSession,
  destroySession,
  SESSION_DURATION_MS,
};
