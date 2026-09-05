// Service Discord: OAuth2 pour les UTILISATEURS (gate getkey)
// - login scope "identify guilds.join" (pattern officiel Discord)
// - ajout au serveur via le BOT (DISCORD_BOT_TOKEN + DISCORD_GUILD_ID)
// - cookie de session user signé HMAC, 24h

const crypto = require('crypto');
const pool = require('../db');

const USER_COOKIE = 'ks_user';
const USER_TTL_MS = 24 * 60 * 60 * 1000;

// ---------- Cookie signé HMAC (userId discord + expiration) ----------
function signUserCookie(discordId) {
  const exp = Date.now() + USER_TTL_MS;
  const payload = `${discordId}.${exp}`;
  const sig = crypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 32);
  return `${payload}.${sig}`;
}

function verifyUserCookie(cookie) {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;
  const [discordId, exp, sig] = parts;
  const expected = crypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(`${discordId}.${exp}`)
    .digest('hex')
    .slice(0, 32);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  if (parseInt(exp, 10) < Date.now()) return null;
  return discordId;
}

// ---------- OAuth URLs ----------
function loginUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds.join',
    state,
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
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  return res.json();
}

async function fetchUser(accessToken) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`user fetch ${res.status}`);
  return res.json();
}

// ---------- Ajout au serveur via le BOT ----------
// Pattern officiel Discord: PUT /guilds/{guild}/members/{user} avec token bot.
// access_token = le token OAuth de l'utilisateur (scope guilds.join requis).
async function addToGuild(accessToken, discordId, username) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const result = { joined: false, reason: null };

  if (!guildId || !botToken) {
    result.reason = 'not_configured';
    // Pas configure: on ne bloque PAS l'utilisateur, on log juste le join manquant
    return result;
  }

  try {
    const res = await fetch(`https://discord.com/api/guilds/${guildId}/members/${discordId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 201 || res.status === 204) {
      result.joined = true;
    } else if (res.status === 403) {
      // le bot n'est pas dans le serveur ou manque la permission CREATE_INSTANT_INVITE
      result.reason = 'bot_forbidden';
      console.error('[discord] addToGuild 403: verifie que le BOT est membre du serveur avec "Create Invite"');
    } else {
      // 200 = deja membre; autre = erreur
      result.joined = res.status === 200 ? true : false;
      result.reason = `status_${res.status}`;
    }
  } catch (e) {
    result.reason = 'network: ' + e.message;
  }
  return result;
}

// ---------- DB ----------
async function upsertJoin(discordId, username, avatar, joined) {
  await pool.query(
    `INSERT INTO discord_joins (discord_id, username, avatar, joined, last_seen)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (discord_id) DO UPDATE SET username = $2, avatar = $3, joined = $5, last_seen = now()`,
    [discordId, username || null, avatar || null, !!joined, !!joined]
  );
}

module.exports = {
  USER_COOKIE,
  USER_TTL_MS,
  signUserCookie,
  verifyUserCookie,
  loginUrl,
  exchangeCode,
  fetchUser,
  addToGuild,
  upsertJoin,
};
