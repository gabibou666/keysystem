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
function loginUrl(redirectUri, state, scope = 'identify guilds.join') {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
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

// Invitation PERMANENTE de secours (max_age = 0).
// Pourquoi: si le bot n'est pas configure cote hebergement (token absent) ou si
// l'API Discord est indisponible, le site se retrouvait SANS lien Discord — or
// l'appartenance au serveur est obligatoire pour obtenir ET utiliser une cle.
// Une invitation permanente ne peut pas expirer (contrairement a l'ancienne
// invitation temporaire codee en dur, qui a fini par casser le parcours).
// Surchargeable par DISCORD_INVITE_URL dans les variables d'environnement.
const DEFAULT_PERMANENT_INVITE = 'https://discord.gg/nrgtDK52Er';
let fallbackChecked = false;

// Verifie une invitation via l'API publique Discord (detecte une invitation
// supprimee/expiree) et alerte une fois si elle n'est plus utilisable.
async function isUsableInvite(url) {
  const code = String(url || '').split('/').pop();
  if (!code) return false;
  try {
    const res = await fetch(`https://discord.com/api/v10/invites/${code}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !data.expires_at; // expires_at null/absent => permanente
  } catch {
    return true; // Discord injoignable: on ne casse pas le parcours pour autant
  }
}

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
        if (Array.isArray(invites)) {
          // Priorite a une invitation PERMANENTE (max_age = 0): une invitation
          // temporaire casse le parcours utilisateur, puisque l'appartenance au
          // serveur est obligatoire pour obtenir ET utiliser une cle.
          const permanentList = invites.filter((i) => i && i.code && i.max_age === 0 && !i.expired);
          // Choix deterministe: on prefere une invitation permanente sur un salon
          // d'accueil (👋welcome, 💬general, 📜rules...) et on ecarte les salons
          // internes (moderation, logs) ou l'arrivee du membre serait inutile.
          const NICE = /welcome|general|chat|rules|accueil|main|start|talk|aide|help/i;
          const BAD = /moderator|mod[-_]|staff|admin|log|private|no-response|bot/i;
          const ranked = permanentList
            .map((i) => {
              const name = (i.channel && i.channel.name) || '';
              return { invite: i, score: BAD.test(name) ? 0 : NICE.test(name) ? 2 : 1 };
            })
            .sort((a, b) => b.score - a.score);
          const permanent = ranked.length ? ranked[0].invite : null;
          const expiring = invites.filter((i) => i && i.code && i.max_age > 0);
          if (permanent) {
            cachedInvite = `https://discord.gg/${permanent.code}`;
            cachedInviteTs = now;
            console.log('[discord] permanent invite in use:', cachedInvite);
            return cachedInvite;
          }
          if (expiring.length) {
            const longest = Math.round(Math.max(...expiring.map((i) => i.max_age)) / 86400);
            console.warn(
              `[discord] NO permanent invite found (${expiring.length} temporary, longest expires in ${longest}d) — creating a permanent invite via bot...`
            );
          }
        }
      }
    } catch {}
  }

  // Creation d'une invitation permanente par le bot (permission "Create Invite"
  // requise). unique:false => Discord renvoie l'invitation existante si le bot
  // en a deja une pour ce salon: pas de duplication a chaque redemarrage.
  const created = await createPermanentInvite();
  if (created) {
    cachedInvite = created;
    cachedInviteTs = now;
    console.log('[discord] permanent invite created:', created);
    return created;
  }

  // Aucune invitation recuperee via l'API (bot non configure cote hebergement,
  // ou erreur Discord): on utilise l'invitation permanente de secours pour ne
  // JAMAIS laisser le parcours sans lien, et on verifie qu'elle est utilisable.
  if (!fallbackChecked) {
    fallbackChecked = true;
    const ok = await isUsableInvite(DEFAULT_PERMANENT_INVITE);
    if (!ok) {
      console.error(
        `[discord] WARNING: fallback invite ${DEFAULT_PERMANENT_INVITE} is no longer valid. ` +
          "Define DISCORD_INVITE_URL in environment variables or run: npm run invite:ensure"
      );
    }
  }
  console.warn(
    `[discord] invite via API unavailable (DISCORD_BOT_TOKEN/DISCORD_GUILD_ID missing or Discord error) — falling back to ${DEFAULT_PERMANENT_INVITE}`
  );
  cachedInvite = DEFAULT_PERMANENT_INVITE;
  cachedInviteTs = now;
  return cachedInvite;
}

// Cree une invitation permanente (max_age 0) sur le premier salon texte ou le
// bot possede la permission de creer des invitations.
async function createPermanentInvite() {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return null;
  try {
    const chRes = await fetch(`https://discord.com/api/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!chRes.ok) {
      console.error(`[discord] unable to list channels (HTTP ${chRes.status})`);
      return null;
    }
    const channels = await chRes.json();
    const candidates = (Array.isArray(channels) ? channels : []).filter(
      (c) => c && c.id && (c.type === 0 || c.type === 5)
    );
    for (const channel of candidates) {
      const res = await fetch(`https://discord.com/api/channels/${channel.id}/invites`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_age: 0, max_uses: 0, unique: false }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const inv = await res.json();
        if (inv && inv.code) return `https://discord.gg/${inv.code}`;
      } else if (res.status === 401 || res.status === 403) {
        console.error(
          `[discord] bot cannot create invite (HTTP ${res.status}): grant "Create Invite" permission to the bot.`
        );
        return null;
      }
    }
  } catch (e) {
    console.error('[discord] createPermanentInvite:', e.message);
  }
  return null;
}

let guildRolesCache = { ts: 0, roles: [] };
async function getGuildRoles() {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return [];
  if (Date.now() - guildRolesCache.ts < 15 * 60 * 1000 && guildRolesCache.roles.length > 0) {
    return guildRolesCache.roles;
  }
  try {
    const res = await fetch(`https://discord.com/api/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      guildRolesCache.roles = await res.json();
      guildRolesCache.ts = Date.now();
      return guildRolesCache.roles;
    }
  } catch (e) {
    console.warn('[discord] getGuildRoles error:', e.message);
  }
  return guildRolesCache.roles || [];
}

let systemChannelCache = { ts: 0, channelId: null };
async function getGuildSystemChannelId() {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (process.env.DISCORD_BOOST_CHANNEL_ID) return process.env.DISCORD_BOOST_CHANNEL_ID;
  if (!guildId || !botToken) return null;
  if (Date.now() - systemChannelCache.ts < 30 * 60 * 1000 && systemChannelCache.channelId !== undefined) {
    return systemChannelCache.channelId;
  }
  try {
    const res = await fetch(`https://discord.com/api/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const g = await res.json();
      systemChannelCache.channelId = g.system_channel_id || null;
      systemChannelCache.ts = Date.now();
      return systemChannelCache.channelId;
    }
  } catch (e) {
    console.warn('[discord] getGuildSystemChannelId error:', e.message);
  }
  return null;
}

let boostMessagesCache = { ts: 0, messages: [] };
async function countUserBoostMessages(discordId) {
  const channelId = await getGuildSystemChannelId();
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken || !discordId) return 0;

  try {
    if (Date.now() - boostMessagesCache.ts > 60 * 1000 || boostMessagesCache.messages.length === 0) {
      const res = await fetch(`https://discord.com/api/channels/${channelId}/messages?limit=100`, {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const msgs = await res.json();
        if (Array.isArray(msgs)) {
          boostMessagesCache.messages = msgs;
          boostMessagesCache.ts = Date.now();
        }
      }
    }
    // Types 8, 9, 10, 11 sont les types natifs Discord de messages de boost
    const boostMsgTypes = [8, 9, 10, 11];
    const userMsgs = boostMessagesCache.messages.filter(
      (m) => boostMsgTypes.includes(m.type) && m.author && m.author.id === discordId
    );
    return userMsgs.length;
  } catch (e) {
    console.warn('[discord] countUserBoostMessages error:', e.message);
    return 0;
  }
}

// Verification temps-reel du statut Server Booster (anti-abus: verification directe sur Discord API)
async function getBoosterStatus(discordId) {
  if (!discordId) return { inGuild: false, isBooster: false, boostCount: 0, premiumSince: null };
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) {
    return { inGuild: false, isBooster: false, boostCount: 0, premiumSince: null, reason: 'bot_not_configured' };
  }

  try {
    const res = await fetch(`https://discord.com/api/guilds/${guildId}/members/${discordId}`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(6000),
    });

    if (res.status === 200) {
      const member = await res.json();
      // premium_since est une date ISO si le membre booste le serveur, sinon null
      const isBooster = Boolean(member && member.premium_since);
      // Mettre aussi a jour le cache de presence
      memberCache.set(discordId, { inGuild: true, ts: Date.now() });

      // Calcul du nombre de boosts:
      // Base: 1 boost si premium_since est defini.
      let boostCount = isBooster ? 1 : 0;
      if (isBooster) {
        // 1. Verification par les messages systeme natifs de boost Discord
        const msgBoosts = await countUserBoostMessages(discordId);
        if (msgBoosts > 1) {
          boostCount = Math.max(boostCount, msgBoosts);
        }

        // 2. Verification par les roles (2x, double, ID configurable)
        if (Array.isArray(member.roles) && member.roles.length > 0) {
          const allRoles = await getGuildRoles();
          const userRoleObjs = allRoles.filter((r) => member.roles.includes(r.id));
          const booster2xRoleId = process.env.DISCORD_BOOSTER_2X_ROLE_ID;

          for (const r of userRoleObjs) {
            if (booster2xRoleId && r.id === booster2xRoleId) {
              boostCount = Math.max(boostCount, 2);
            } else if (/3x|triple|3\s*boost/i.test(r.name)) {
              boostCount = Math.max(boostCount, 3);
            } else if (/2x|double|2\s*boost/i.test(r.name)) {
              boostCount = Math.max(boostCount, 2);
            }
          }
        }
      }

      return {
        inGuild: true,
        isBooster,
        boostCount,
        premiumSince: member.premium_since || null,
        roles: member.roles || [],
      };
    } else if (res.status === 404) {
      memberCache.set(discordId, { inGuild: false, ts: Date.now() });
      return { inGuild: false, isBooster: false, boostCount: 0, premiumSince: null };
    } else if (res.status === 429) {
      console.warn('[discord] getBoosterStatus rate-limited (429)');
      return { inGuild: true, isBooster: false, boostCount: 0, premiumSince: null, rateLimited: true };
    }
    return { inGuild: true, isBooster: false, boostCount: 0, premiumSince: null };
  } catch (e) {
    console.warn('[discord] getBoosterStatus network error:', e.message);
    return { inGuild: true, isBooster: false, boostCount: 0, premiumSince: null };
  }
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
  getBoosterStatus,
};
