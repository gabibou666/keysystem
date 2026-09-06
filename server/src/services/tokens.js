// Tokens signés anti-bypass (jsonwebtoken — npmjs.com/package/jsonwebtoken)
// Principe: le checkpoint complété (postback) genere un JWT:
//   - signe avec HMAC_SECRET (secret serveur, jamais expose)
//   - TTL court (5 min)
//   - claims lies: puid + owner (Discord) + IP
//   - a usage unique: le status le consomme (jti verifie en DB via completion_token)
// Sans ce token, /api/key/status refuse de delivrer la cle.

const jwt = require('jsonwebtoken');

const SECRET = process.env.HMAC_SECRET;
const COMPLETION_TTL_SEC = 5 * 60; // 5 minutes (brief: 2-5 min)

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
