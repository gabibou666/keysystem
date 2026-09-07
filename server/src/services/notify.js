// Notifications Discord — webhook embeds non-bloquants
// Usage: await notifyDiscord({ title, description, color, fields })
// Echoue silencieusement (jamais de crash metier a cause d'une notif).

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const COLORS = {
  sale: 0xa855f7,      // violet: vente robux
  key: 0x8b5cf6,       // violet clair: cle delivree
  ban: 0xf472b6,       // rouge-violet: ban
  warn: 0xe879f9,      // fuchsia: alerte securite
  info: 0x71717a,      // gris: info
};

async function notifyDiscord({ title, description, color = 'info', fields = [] }) {
  if (!WEBHOOK_URL) return; // non configure: silencieux
  try {
    const body = JSON.stringify({
      username: 'KeySystem',
      embeds: [
        {
          title: String(title || '').slice(0, 250),
          description: description ? String(description).slice(0, 4000) : undefined,
          color: COLORS[color] || COLORS.info,
          fields: (fields || []).slice(0, 10).map((f) => ({
            name: String(f.name || '').slice(0, 100),
            value: String(f.value ?? '—').slice(0, 500),
            inline: f.inline !== false,
          })),
          timestamp: new Date().toISOString(),
          footer: { text: 'KeySystem · automated' },
        },
      ],
    });
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) {
      // rate limit Discord: attend le retry_after et rejoue une fois
      const data = await res.json().catch(() => null);
      const wait = Math.min((data?.retry_after || 1) * 1000, 5000);
      await new Promise((r) => setTimeout(r, wait));
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    }
  } catch {
    /* notifications = best effort */
  }
}

module.exports = { notifyDiscord };
