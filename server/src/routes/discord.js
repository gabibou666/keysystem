// Routes OAuth Discord pour les UTILISATEURS (gate getkey)
// /api/discord/login -> /api/discord/callback -> /api/discord/status
const express = require('express');
const nodeCrypto = require('crypto');
const discord = require('../services/discord');
const pool = require('../db');

const router = express.Router();

function userRedirectUri(req) {
  return `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/discord/callback`;
}

// Etat anti-CSRF signe (10 min de validite)
function signState() {
  const exp = Date.now() + 10 * 60 * 1000;
  const sig = nodeCrypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(String(exp))
    .digest('hex')
    .slice(0, 16);
  return `${exp}.${sig}`;
}
function verifyState(state) {
  if (!state) return false;
  const [exp, sig] = state.split('.');
  if (!exp || !sig) return false;
  if (parseInt(exp, 10) < Date.now()) return false;
  const expected = nodeCrypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(exp)
    .digest('hex')
    .slice(0, 16);
  return sig === expected;
}

// ---------- GET /api/discord/login ----------
router.get('/login', (req, res) => {
  res.redirect(discord.loginUrl(userRedirectUri(req), signState()));
});

// ---------- GET /api/discord/callback ----------
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error === 'access_denied') {
    return res.redirect('/getkey?login=denied');
  }
  if (!code || !verifyState(state)) {
    return res.redirect('/getkey?login=invalid');
  }
  try {
    const tokenData = await discord.exchangeCode(code, userRedirectUri(req));
    const user = await discord.fetchUser(tokenData.access_token);
    const username = user.global_name || user.username;

    // Ajoute au serveur via le bot (silencieux si non configure)
    const join = await discord.addToGuild(tokenData.access_token, user.id, username);

    // DB
    await discord.upsertJoin(user.id, username, user.avatar, join.joined);

    // Cookie session user signe
    res.cookie(discord.USER_COOKIE, discord.signUserCookie(user.id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: discord.USER_TTL_MS,
    });

    res.redirect('/getkey?login=ok');
  } catch (e) {
    console.error('[discord/callback]', e);
    res.redirect('/getkey?login=error');
  }
});

// ---------- GET /api/discord/status ----------
// Le front interroge pour savoir si l'utilisateur est connecte
router.get('/status', async (req, res) => {
  const discordId = discord.verifyUserCookie(req.cookies && req.cookies[discord.USER_COOKIE]);
  if (!discordId) return res.json({ loggedIn: false });
  const { rows } = await pool.query(
    'SELECT username, avatar, joined FROM discord_joins WHERE discord_id = $1',
    [discordId]
  );
  res.json({
    loggedIn: true,
    username: rows[0] ? rows[0].username : null,
    avatar: rows[0] && rows[0].avatar
      ? `https://cdn.discordapp.com/avatars/${discordId}/${rows[0].avatar}.png`
      : null,
    inServer: rows[0] ? rows[0].joined : false,
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
