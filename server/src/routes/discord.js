// Developer OAuth Discord.
const express = require('express');
const nodeCrypto = require('crypto');
const discord = require('../services/discord');
const auth = require('../services/developer-auth');
const registration = require('../services/registration-guard');

const router = express.Router();

function userRedirectUri(req) {
  return `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/discord/callback`;
}

// Etat anti-CSRF signe (10 min de validite)
function signState() {
  const exp = Date.now() + 10 * 60 * 1000;
  const suffix = `.${nodeCrypto.randomBytes(16).toString('hex')}.developer`;
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
  if (state.split('.').length !== 4 || purpose !== 'developer' || !/^[a-f0-9]{32}$/.test(nonce || '')) return false;
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
  registration.context(req,res);
  const state = signState();
  res.cookie('ah_oauth_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production' || userRedirectUri(req).startsWith('https:'), sameSite: 'lax', maxAge: 600000, path: '/api/discord' });
  res.redirect(discord.loginUrl(userRedirectUri(req), state, 'identify email'));
});

// ---------- GET /api/discord/callback ----------
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const destination = '/dashboard';
  if (error === 'access_denied') {
    return res.redirect(`${destination}?login=denied`);
  }
  if (typeof code !== 'string' || !code || code.length > 4096 || !verifyState(state)) {
    return res.redirect(`${destination}?login=invalid`);
  }
  if (req.cookies?.ah_oauth_state !== state) return res.redirect(`${destination}?login=invalid`);
  res.clearCookie('ah_oauth_state', { path: '/api/discord' });
  try {
    const tokenData = await discord.exchangeCode(code, userRedirectUri(req));
    const user = await discord.fetchUser(tokenData.access_token);
    const username = user.global_name || user.username;
      const id = await auth.socialAccount('discord', user.id, username,{email:user.email,emailVerified:user.verified===true},registration.context(req,res));
      await auth.createSession(id, res);
      return res.redirect('/dashboard?login=ok');

  } catch (e) {
    console.error('[discord/callback]', e.code || e.name);
    if(['ACCOUNT_EXISTS','VERIFIED_EMAIL_REQUIRED','ACCOUNT_CREATION_LIMIT'].includes(e.code)) {
      const reason={ACCOUNT_EXISTS:'account_exists',VERIFIED_EMAIL_REQUIRED:'verified_email_required',ACCOUNT_CREATION_LIMIT:'account_creation_limit'}[e.code];
      return res.redirect('/login?error='+reason);
    }
    res.redirect(`${destination}?login=error`);
  }
});

module.exports = { router };
