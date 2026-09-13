// Anti-DDoS & Flood Protection Service — KeySystem
// Détection des attaques Layer-7 (HTTP Floods), mise en quarantaine (auto-jail)
// et alerte en temps réel sur Discord Webhook.

const { notifyDiscord } = require('./notify');

// ===== Configuration des seuils =====
const WINDOW_MS = 10 * 1000;         // Fenêtre de mesure glissante (10 secondes)
const SOFT_LIMIT = 60;               // Limite de courtoisie (max 60 req / 10s ~ 6 req/s)
const DDOS_THRESHOLD = 95;           // Seuil d'attaque DDoS (95+ req / 10s = ban direct)
const JAIL_DURATION_MS = 15 * 60 * 1000; // Durée de quarantaine (15 minutes)
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // Cooldown webhook par IP (évite de spammer Discord)

// Mémoire vive ultra-rapide
const trackedIPs = new Map();     // ip -> { count, windowStart, lastPath, userAgent }
const jailedIPs = new Map();      // ip -> { jailUntil, peakCount, targetPath, userAgent }
const alertCooldowns = new Map(); // ip -> lastAlertTimestamp

let totalBlockedAttacks = 0;

// Whitelist des IPs / chemins de confiance
const WHITELIST_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost',
]);

function getClientIp(req) {
  let ip =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Vérifie si la route est exemptée (ex: auto-ping de Render / keepalive)
function isExemptPath(path) {
  return path === '/api/keepalive' || path === '/favicon.ico';
}

async function triggerDdosAlert(ip, count, durationMs, targetPath, userAgent) {
  const now = Date.now();
  const lastAlert = alertCooldowns.get(ip) || 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) {
    return; // Évite de saturer le webhook Discord si l'attaquant continue
  }
  alertCooldowns.set(ip, now);

  const durationSec = Math.max(0.5, durationMs / 1000);
  const rps = (count / durationSec).toFixed(1);

  await notifyDiscord({
    title: '🚨 Anti-DDoS : Attaque Détectée & Bloquée',
    description: `Une tentative d'inondation HTTP (Layer-7 Flood) a été interceptée. L'IP source a été immédiatement bannie.`,
    color: 'ddos',
    fields: [
      { name: '🌐 IP Attaquant', value: `\`${ip}\``, inline: true },
      { name: '🎯 Route Ciblée', value: `\`${targetPath.slice(0, 100)}\``, inline: true },
      { name: '⚡ Intensité', value: `**${count}** requêtes en **${durationSec.toFixed(1)}s** (~${rps} req/s)`, inline: true },
      { name: '🤖 User-Agent', value: `\`${(userAgent || 'inconnu').slice(0, 100)}\``, inline: false },
      { name: '🚫 Sanction', value: `IP en prison (Jail) pour **15 minutes**`, inline: true },
      { name: '🕒 Horodatage', value: `<t:${Math.floor(now / 1000)}:R>`, inline: true },
    ],
  });
}

function antiDdosMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  // 1. IP blanche ou chemin de keepalive : passe sans analyse
  if (WHITELIST_IPS.has(ip) || isExemptPath(req.path)) {
    return next();
  }

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
    tracker = {
      count: 1,
      windowStart: now,
      lastPath: req.path,
      userAgent: req.headers['user-agent'] || '',
    };
    trackedIPs.set(ip, tracker);
    return next();
  }

  tracker.count++;
  tracker.lastPath = req.path;
  tracker.userAgent = req.headers['user-agent'] || tracker.userAgent;

  // 4. Seuil d'attaque DDoS franchi -> Mise en prison immédiate + alerte
  if (tracker.count >= DDOS_THRESHOLD) {
    const jailUntil = now + JAIL_DURATION_MS;
    jailedIPs.set(ip, {
      jailUntil,
      peakCount: tracker.count,
      targetPath: req.originalUrl || req.path,
      userAgent: tracker.userAgent,
    });
    totalBlockedAttacks++;

    console.warn(`[anti-ddos] ALERTE: IP ${ip} bloquée et bannie pour 15m (${tracker.count} reqs en ${(now - tracker.windowStart) / 1000}s sur ${req.path})`);

    // Alerte Discord asynchrone non-bloquante
    triggerDdosAlert(
      ip,
      tracker.count,
      now - tracker.windowStart,
      req.originalUrl || req.path,
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

// Nettoyage régulier de la mémoire (toutes les 5 minutes)
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
}, 5 * 60 * 1000).unref();

function getStats() {
  return {
    totalBlockedAttacks,
    currentJailedCount: jailedIPs.size,
    currentlyTrackedIPs: trackedIPs.size,
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
};
