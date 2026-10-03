// Routes OAuth Discord pour les UTILISATEURS (gate getkey)
// /api/discord/login -> /api/discord/callback -> /api/discord/status
const express = require('express');
const nodeCrypto = require('crypto');
const discord = require('../services/discord');
const auth = require('../services/developer-auth');

const router = express.Router();

function userRedirectUri(req) {
  return `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/discord/callback`;
}

// Etat anti-CSRF signe (10 min de validite)
function signState(purpose = '') {
  const exp = Date.now() + 10 * 60 * 1000;
  const suffix = purpose === 'developer' ? `.${nodeCrypto.randomBytes(16).toString('hex')}.developer` : '';
  const sig = nodeCrypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(String(exp) + suffix)
    .digest('hex')
    .slice(0, 16);
  return `${exp}.${sig}${suffix}`;
}
function verifyState(state) {
  if (typeof state !== 'string') return false;
  const [exp, sig, nonce, purpose] = state.split('.');
  if (!/^\d+$/.test(exp || '') || !/^[a-f0-9]{16}$/.test(sig || '')) return false;
  if (state.split('.').length !== 2 && (state.split('.').length !== 4 || purpose !== 'developer' || !/^[a-f0-9]{32}$/.test(nonce || ''))) return false;
  if (!exp || !sig) return false;
  if (parseInt(exp, 10) < Date.now()) return false;
  const expected = nodeCrypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(exp + (purpose === 'developer' && /^[a-f0-9]{32}$/.test(nonce || '') ? `.${nonce}.developer` : ''))
    .digest('hex')
    .slice(0, 16);
  return nodeCrypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------- GET /api/discord/login ----------
router.get('/login', (req, res) => {
  if (req.query.mode === 'developer') {
    const state = signState('developer');
    res.cookie('ah_oauth_state', state, { httpOnly: true, secure: userRedirectUri(req).startsWith('https:'), sameSite: 'lax', maxAge: 600000, path: '/api/discord' });
    return res.redirect(discord.loginUrl(userRedirectUri(req), state, 'identify'));
  }
  res.redirect(discord.loginUrl(userRedirectUri(req), signState()));
});

// ---------- GET /api/discord/callback ----------
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const developerLogin = typeof state === 'string' && state.endsWith('.developer');
  const destination = developerLogin ? '/dashboard' : '/getkey';
  if (error === 'access_denied') {
    return res.redirect(`${destination}?login=denied`);
  }
  if (!code || !verifyState(state)) {
    return res.redirect(`${destination}?login=invalid`);
  }
  if (developerLogin && req.cookies?.ah_oauth_state !== state) return res.redirect('/dashboard?login=invalid');
  res.clearCookie('ah_oauth_state', { path: '/api/discord' });
  try {
    const tokenData = await discord.exchangeCode(code, userRedirectUri(req));
    const user = await discord.fetchUser(tokenData.access_token);
    const username = user.global_name || user.username;
    if (developerLogin) {
      const id = await auth.socialAccount('discord', user.id, username);
      await auth.createSession(id, res);
      return res.redirect('/dashboard?login=ok');
    }

    // Ajoute au serveur via le bot (silencieux si non configure)
    const join = developerLogin ? null : await discord.addToGuild(tokenData.access_token, user.id, username);

    // DB
    if (join) await discord.upsertJoin(user.id, username, user.avatar, join.joined);

    // Cookie session user signe
    const isHttps = req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.cookie(discord.USER_COOKIE, discord.signUserCookie(user.id), {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      maxAge: discord.USER_TTL_MS,
      path: '/',
    });

    res.redirect(`${destination}?login=ok`);
  } catch (e) {
    console.error('[discord/callback]', e);
    res.redirect(`${destination}?login=error`);
  }
});

// ---------- GET /api/discord/status ----------
// Le front interroge pour savoir si l'utilisateur est connecte
router.get('/status', async (req, res) => {
  const discordId = discord.verifyUserCookie(req.cookies && req.cookies[discord.USER_COOKIE]);
  if (!discordId) return res.json({ loggedIn: false });
  const [rows, inServer, inviteUrl] = await Promise.all([
    pool.query('SELECT username, avatar, joined FROM discord_joins WHERE discord_id = $1', [discordId]),
    discord.isGuildMember(discordId),
    discord.getGuildInvite(),
  ]);
  res.json({
    loggedIn: true,
    discordId,
    username: rows.rows[0] ? rows.rows[0].username : null,
    avatar: rows.rows[0] && rows.rows[0].avatar
      ? `https://cdn.discordapp.com/avatars/${discordId}/${rows.rows[0].avatar}.png`
      : null,
    inServer,
    inviteUrl: inServer ? null : inviteUrl,
  });
});

// ---------- Middleware: exige un utilisateur connecte ----------
async function requireDiscordUser(req, res, next) {
  const discordId = discord.verifyUserCookie(req.cookies && req.cookies[discord.USER_COOKIE]);
  if (!discordId) {
    return res.status(401).json({ success: false, reason: 'discord_required', error: 'Sign in with Discord to get a key.' });
  }
  req.discordId = discordId;
  next();
}

// ---------- POST /api/discord/logout ----------
router.post('/logout', (req, res) => {
  res.clearCookie(discord.USER_COOKIE);
  res.json({ success: true });
});

module.exports = { router, requireDiscordUser };
