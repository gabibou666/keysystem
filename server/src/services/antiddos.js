// Anti-DDoS & Flood Protection Service — KeySystem
// Détection des attaques Layer-7 (HTTP Floods), mise en quarantaine (auto-jail)
// et alerte en temps réel sur Discord Webhook.
//
// SECURITE DE LA SOURCE D'IP (important):
//   Les en-tetes X-Forwarded-For / CF-Connecting-IP sont FOURNIS PAR LE CLIENT
//   et donc falsifiables. Les lire directement permettait:
//     1. de contourner le jail en changeant d'en-tete a chaque requete;
//     2. de faire bannir 15 minutes l'IP d'un TIERS (flood en mettant l'IP de la
//        victime dans X-Forwarded-For).
//   On utilise donc req.ip (Express applique la chaine de proxies declaree par
//   `trust proxy`) et on refuse de tracker les adresses non publiques: mettre en
//   prison un noeud d'infrastructure (Cloudflare/Render) bloquerait TOUS les
//   utilisateurs d'un coup.

const { notifyDiscord } = require('./notify');
const { isIP } = require('net');
const { diagnosticUrl } = require('./private-diagnostics');

// ===== Configuration des seuils =====
const WINDOW_MS = 10 * 1000;         // Fenêtre de mesure glissante (10 secondes)
const SOFT_LIMIT = 60;               // Limite de courtoisie (max 60 req / 10s ~ 6 req/s)
const DDOS_THRESHOLD = 95;           // Seuil d'attaque DDoS (95+ req / 10s = ban direct)
const JAIL_DURATION_MS = 15 * 60 * 1000; // Durée de quarantaine (15 minutes)
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // Cooldown webhook par IP (évite de spammer Discord)
const MAX_TRACKED_IPS = 10000;
const MAX_JAILED_IPS = 10000;
const MAX_ALERT_IPS = 10000;

// Option explicite, a activer UNIQUEMENT si tout le trafic passe par Cloudflare:
//   IP_HEADER=cf-connecting-ip
const IP_HEADER = (process.env.IP_HEADER || '').toLowerCase();

// Mémoire vive ultra-rapide
const trackedIPs = new Map();     // ip -> { count, windowStart, lastPath, userAgent }
const jailedIPs = new Map();      // ip -> { jailUntil, peakCount, targetPath, userAgent }
const alertCooldowns = new Map(); // ip -> lastAlertTimestamp
const seenChains = new Map();     // ip -> chaine d'en-tetes observee (diagnostic)

let totalBlockedAttacks = 0;

function isPrivateOrReserved(ip) {
  if (!ip) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // CGNAT operateurs
  if (/^0\./.test(ip)) return true;
  if (ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return true; // IPv6 prive
  if (ip.startsWith('::ffff:')) return isPrivateOrReserved(ip.slice(7));
  return false;
}

// Source d'IP fiable. `null` => aucun tracking (on ne juge pas ce qu'on ne peut
// pas identifier de facon sure).
function getClientIp(req) {
  let ip = '';

  if (IP_HEADER === 'cf-connecting-ip') {
    // Suppose que TOUT le trafic arrive par Cloudflare (sinon l'en-tete est
    // fourni par le client et donc falsifiable).
    ip = String(req.headers['cf-connecting-ip'] || '').trim();
  }
  if (!ip) ip = req.ip || req.socket?.remoteAddress || '';

  ip = String(ip).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';

  // Validation stricte: un en-tete d'IP exotic (mode IP_HEADER) ne doit JAMAIS
  // se retrouver stocke puis reaffiche dans le panel admin (injection HTML).
  if (!isIP(ip)) return null;
  return ip;
}

// Diagnostic: conserve la chaine d'en-tetes observee pour une IP donnee,
// affichable dans le panel admin pour verifier que `trust proxy` est correct.
function rememberChain(ip, req) {
  if (seenChains.has(ip) || seenChains.size > 50) return;
  seenChains.set(ip, {
    resolved: ip,
    remote: req.socket?.remoteAddress || '?',
    xff: String(req.headers['x-forwarded-for'] || '').slice(0, 120),
    cf: String(req.headers['cf-connecting-ip'] || '').slice(0, 60),
    at: Date.now(),
  });
}

// Vérifie si la route est exemptée (auto-ping Render, sante, SEO)
function isExemptPath(path) {
  return (
    path === '/api/keepalive' ||
    path === '/healthz' ||
    path === '/favicon.ico' ||
    path === '/robots.txt' ||
    path === '/sitemap.xml'
  );
}

async function triggerDdosAlert(ip, count, durationMs, targetPath, userAgent) {
  const now = Date.now();
  const lastAlert = alertCooldowns.get(ip) || 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) {
    return; // Évite de saturer le webhook Discord si l'attaquant continue
  }
  if (!alertCooldowns.has(ip) && alertCooldowns.size >= MAX_ALERT_IPS) return;
  alertCooldowns.set(ip, now);

  const durationSec = Math.max(0.5, durationMs / 1000);
  const rps = (count / durationSec).toFixed(1);

  await notifyDiscord({
    title: '🚨 Anti-DDoS: attack detected & blocked',
    description: 'A Layer-7 HTTP flood attempt was intercepted and the source IP was banned immediately.',
    color: 'ddos',
    fields: [
      { name: '🌐 Attacker IP', value: `\`${ip}\``, inline: true },
      { name: '🎯 Targeted route', value: `\`${targetPath.slice(0, 100)}\``, inline: true },
      { name: '⚡ Intensity', value: `**${count}** requests in **${durationSec.toFixed(1)}s** (~${rps} req/s)`, inline: true },
      { name: '🤖 User-Agent', value: `\`${(userAgent || 'unknown').slice(0, 100)}\``, inline: false },
      { name: '🚫 Sanction', value: 'IP jailed for **15 minutes**', inline: true },
      { name: '🕒 Horodatage', value: `<t:${Math.floor(now / 1000)}:R>`, inline: true },
    ],
  });
}

function antiDdosMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  // 0. IP non identifiable: on ne tracke pas (faux positifs catastrophiques).
  if (!ip || isPrivateOrReserved(ip)) return next();

  // 1. Chemin exempte (keepalive/sante/SEO): passe sans analyse
  if (isExemptPath(req.path)) return next();
  rememberChain(ip, req);

  // 2. Vérification si l'IP est déjà en prison (Jail)
  const jailInfo = jailedIPs.get(ip);
  if (jailInfo) {
    if (now < jailInfo.jailUntil) {
      totalBlockedAttacks++;
      const retryAfter = Math.max(1, Math.ceil((jailInfo.jailUntil - now) / 1000));
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        success: false,
        error: 'Blocked by KeySystem Anti-DDoS protection. Access suspended.',
        retryAfter,
      });
    } else {
      // Fin de la peine de prison
      jailedIPs.delete(ip);
      trackedIPs.delete(ip);
    }
  }

  // 3. Suivi du débit de requêtes
  let tracker = trackedIPs.get(ip);
  if (!tracker || now - tracker.windowStart > WINDOW_MS) {
    if (!tracker && trackedIPs.size >= MAX_TRACKED_IPS) {
      totalBlockedAttacks++;
      res.setHeader('Retry-After', 30);
      return res.status(429).json({ success: false, error: 'Server busy. Please try again shortly.', retryAfter: 30 });
    }
    tracker = {
      count: 1,
      windowStart: now,
      lastPath: diagnosticUrl(req.path),
      userAgent: req.headers['user-agent'] || '',
    };
    trackedIPs.set(ip, tracker);
    return next();
  }

  tracker.count++;
  tracker.lastPath = diagnosticUrl(req.path);
  tracker.userAgent = req.headers['user-agent'] || tracker.userAgent;

  // 4. Seuil d'attaque DDoS franchi -> Mise en prison immédiate + alerte
  if (tracker.count >= DDOS_THRESHOLD) {
    const jailUntil = now + JAIL_DURATION_MS;
    if (jailedIPs.has(ip) || jailedIPs.size < MAX_JAILED_IPS) jailedIPs.set(ip, {
      jailUntil,
      peakCount: tracker.count,
      targetPath: diagnosticUrl(req.path),
      userAgent: tracker.userAgent,
    });
    totalBlockedAttacks++;

    console.warn(`[anti-ddos] ALERTE: IP ${ip} bloquée et bannie pour 15m (${tracker.count} reqs en ${(now - tracker.windowStart) / 1000}s sur ${diagnosticUrl(req.path)})`);

    // Alerte Discord asynchrone non-bloquante
    triggerDdosAlert(
      ip,
      tracker.count,
      now - tracker.windowStart,
      diagnosticUrl(req.path),
      tracker.userAgent
    ).catch(() => {});

    const retryAfter = Math.ceil(JAIL_DURATION_MS / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      success: false,
      error: 'DDoS flood attempt detected. Your IP has been banned for 15 minutes.',
      retryAfter,
    });
  }

  // 5. Throttling doux (entre 60 et 94 reqs / 10s)
  if (tracker.count > SOFT_LIMIT) {
    totalBlockedAttacks++;
    res.setHeader('Retry-After', 5);
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Please slow down your requests.',
      retryAfter: 5,
    });
  }

  next();
}

// Memory-only cleanup keeps the bounded tracker available without database I/O.
setInterval(() => {
  const now = Date.now();
  // Purge trackers inactifs
  for (const [ip, tracker] of trackedIPs.entries()) {
    if (now - tracker.windowStart > WINDOW_MS * 3) {
      trackedIPs.delete(ip);
    }
  }
  // Purge prisons expirées
  for (const [ip, info] of jailedIPs.entries()) {
    if (now >= info.jailUntil) {
      jailedIPs.delete(ip);
    }
  }
  // Purge vieux cooldowns
  for (const [ip, time] of alertCooldowns.entries()) {
    if (now - time > ALERT_COOLDOWN_MS * 2) {
      alertCooldowns.delete(ip);
    }
  }
  // Purge du diagnostic
  for (const [ip, chain] of seenChains.entries()) {
    if (now - chain.at > 60 * 60 * 1000) seenChains.delete(ip);
  }
}, 30 * 1000).unref();

function getStats() {
  const now = Date.now();
  const jailedList = [];
  for (const [ip, info] of jailedIPs.entries()) {
    if (now < info.jailUntil) {
      jailedList.push({
        ip,
        jailUntil: info.jailUntil,
        remainingSec: Math.max(0, Math.ceil((info.jailUntil - now) / 1000)),
        peakCount: info.peakCount || 0,
        targetPath: info.targetPath || 'N/A',
        userAgent: info.userAgent || 'N/A',
      });
    }
  }
  return {
    totalBlockedAttacks,
    currentJailedCount: jailedIPs.size,
    currentlyTrackedIPs: trackedIPs.size,
    jailedList,
    // Diagnostic: verifier que l'IP resolue est bien celle du visiteur.
    // Si `resolved` ressemble a une IP Cloudflare/infra au lieu de l'IP du
    // client, ajuster TRUST_PROXY (ou definir IP_HEADER=cf-connecting-ip).
    ipResolution: {
      trustProxy: process.env.TRUST_PROXY || '(defaut 1)',
      headerOverride: IP_HEADER || null,
      samples: Array.from(seenChains.values()).slice(-5),
    },
  };
}

function unbanIP(ip) {
  const removed = jailedIPs.delete(ip);
  trackedIPs.delete(ip);
  alertCooldowns.delete(ip);
  return removed;
}

module.exports = {
  antiDdosMiddleware,
  getStats,
  unbanIP,
  getClientIp,
  isPrivateOrReserved,
};
