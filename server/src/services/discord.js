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

// ---------- Verification de presence sur le serveur (Anti-Leave) ----------
const memberCache = new Map(); // discordId -> { inGuild: boolean, ts: number }
let cachedInvite = null;
let cachedInviteTs = 0;

async function isGuildMember(discordId) {
  if (!discordId) return true;
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return true;

  const now = Date.now();
  const cached = memberCache.get(discordId);
  // Cache 5 minutes si membre, 30 secondes si non-membre (detecte rapidement si le joueur rejoint a nouveau)
  const ttl = cached && cached.inGuild ? 5 * 60 * 1000 : 30 * 1000;
  if (cached && now - cached.ts < ttl) {
    return cached.inGuild;
  }

  try {
    const res = await fetch(`https://discord.com/api/guilds/${guildId}/members/${discordId}`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(6000),
    });

    if (res.status === 200) {
      memberCache.set(discordId, { inGuild: true, ts: now });
      return true;
    } else if (res.status === 404) {
      memberCache.set(discordId, { inGuild: false, ts: now });
      return false;
    } else if (res.status === 429) {
      console.warn('[discord] isGuildMember rate-limited (429), fail-open temporaire');
      return cached ? cached.inGuild : true;
    }
    // Fail-open sur erreur 5xx pour ne pas bloquer les joueurs si Discord a un incident
    return true;
  } catch (e) {
    console.warn('[discord] isGuildMember network error:', e.message);
    return cached ? cached.inGuild : true;
  }
}

async function getGuildInvite() {
  if (process.env.DISCORD_INVITE_URL) return process.env.DISCORD_INVITE_URL;
  const now = Date.now();
  if (cachedInvite && now - cachedInviteTs < 30 * 60 * 1000) {
    return cachedInvite;
  }
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (guildId && botToken) {
    try {
      const res = await fetch(`https://discord.com/api/guilds/${guildId}/invites`, {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const invites = await res.json();
        if (Array.isArray(invites) && invites[0] && invites[0].code) {
          cachedInvite = `https://discord.gg/${invites[0].code}`;
          cachedInviteTs = now;
          return cachedInvite;
        }
      }
    } catch {}
  }
  return 'https://discord.gg/2ZT28kXZR';
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
  isGuildMember,
  getGuildInvite,
};
