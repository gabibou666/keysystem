// Tokens signés anti-Bypass (jsonwebtoken — npmjs.com/package/jsonwebtoken)
// Principe: le checkpoint complété (postback) genere un JWT:
//   - signe avec HMAC_SECRET (secret serveur, jamais expose)
//   - TTL 30 min (voir COMPLETION_TTL_SEC)
//   - claims lies: puid + owner (Discord) + IP
//   - a usage unique: le status le consomme (claim atomique en DB)
// Sans ce token, /api/key/status refuse de delivrer la cle.

const jwt = require('jsonwebtoken');

const SECRET = process.env.HMAC_SECRET;
// TTL 30 minutes: assez long pour que l'utilisateur finisse sa pub et revienne
// (les pages de reward LootLabs font trainer), assez court pour rester a
// usage unique et non rejouable. Un token expire = session a recommencer,
// ce qui generait des tickets support inutiles a 5 min.
const COMPLETION_TTL_SEC = 30 * 60; // 30 minutes

// Genere le token de completion d'un checkpoint (appele au postback, cote serveur uniquement)
function issueCompletionToken({ puid, ownerDiscordId, ip, tasksDone, tasksRequired }) {
  return jwt.sign(
    {
      purpose: 'll_completion', // distingue des autres usages JWT eventuels
      puid,
      owner: ownerDiscordId || null,
      ip: ip || null,
      tasksDone,
      tasksRequired,
    },
    SECRET,
    { expiresIn: COMPLETION_TTL_SEC, jwtid: 'ct-' + puid } // jti unique par session
  );
}

// Verifie un token de completion. Retourne { valid, payload, reason }
function verifyCompletionToken(token, { expectPuid } = {}) {
  try {
    const payload = jwt.verify(token, SECRET); // lève si expiré/signature invalide
    if (payload.purpose !== 'll_completion') {
      return { valid: false, reason: 'wrong_purpose' };
    }
    if (expectPuid && payload.puid !== expectPuid) {
      return { valid: false, reason: 'puid_mismatch' };
    }
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, reason: e.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
}

module.exports = { issueCompletionToken, verifyCompletionToken, COMPLETION_TTL_SEC };
