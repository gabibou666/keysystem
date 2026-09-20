#!/usr/bin/env node
// ============================================================================
// ensure-discord-invite.js — garantit une invitation Discord PERMANENTE.
// ----------------------------------------------------------------------------
// Pourquoi: l'appartenance au serveur Discord est obligatoire pour obtenir ET
// utiliser une cle. Une invitation temporaire (7 jours, comme celle codee en dur
// historiquement dans le front) transforme donc le site en impasse pour tous les
// nouveaux utilisateurs des qu'elle expire.
//
// Usage:  node scripts/ensure-discord-invite.js
// Lit DISCORD_BOT_TOKEN + DISCORD_GUILD_ID depuis l'environnement ou server/.env.
// Le bot doit avoir la permission "Create Invite" sur un salon texte.
// ============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const API = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

function authHeaders() {
  return { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' };
}

async function api(pathname, options = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

function fmtAge(maxAge) {
  if (maxAge === 0) return 'PERMANENTE';
  const days = maxAge / 86400;
  return days >= 1 ? `${days.toFixed(days % 1 ? 1 : 0)} j` : `${Math.round(maxAge / 3600)} h`;
}

(async () => {
  if (!BOT_TOKEN || !GUILD_ID) {
    console.error('❌ DISCORD_BOT_TOKEN et DISCORD_GUILD_ID sont requis (env ou server/.env).');
    process.exit(1);
  }

  const me = await api('/users/@me');
  if (!me.ok) {
    console.error(`❌ Token bot refuse par Discord (HTTP ${me.status}).`);
    process.exit(1);
  }
  console.log(`🤖 Bot: ${me.data.username}#${me.data.discriminator || '0'}`);

  const invites = await api(`/guilds/${GUILD_ID}/invites`);
  if (!invites.ok) {
    console.error(
      `❌ Impossible de lister les invitations du serveur (HTTP ${invites.status}). ` +
        'Verifie que le bot est bien membre du serveur.'
    );
    process.exit(1);
  }

  const list = Array.isArray(invites.data) ? invites.data : [];
  console.log(`\n📋 ${list.length} invitation(s) existante(s):`);
  for (const inv of list) {
    console.log(
      `   • discord.gg/${inv.code}  age=${fmtAge(inv.max_age)}  uses=${inv.uses ?? 0}${
        inv.max_uses ? '/' + inv.max_uses : ''
      }  salon=${inv.channel?.name || '?'}`
    );
  }

  const permanent = list.find((i) => i && i.code && i.max_age === 0);
  if (permanent) {
    console.log('\n✅ Une invitation permanente existe deja — rien a creer.');
    console.log(`\nDISCORD_INVITE_URL=https://discord.gg/${permanent.code}`);
    return;
  }

  const channels = await api(`/guilds/${GUILD_ID}/channels`);
  if (!channels.ok) {
    console.error(`❌ Impossible de lister les salons (HTTP ${channels.status}).`);
    process.exit(1);
  }
  const candidates = (channels.data || []).filter((c) => c.type === 0 || c.type === 5);
  if (!candidates.length) {
    console.error('❌ Aucun salon texte: impossible de creer une invitation.');
    process.exit(1);
  }

  console.log('\n⚠️  Aucune invitation permanente: creation en cours...');
  for (const channel of candidates) {
    const created = await api(`/channels/${channel.id}/invites`, {
      method: 'POST',
      body: JSON.stringify({ max_age: 0, max_uses: 0, unique: false, temporary: false }),
    });
    if (created.ok && created.data && created.data.code) {
      console.log(`✅ Invitation permanente creee sur #${channel.name}`);
      console.log(`\nDISCORD_INVITE_URL=https://discord.gg/${created.data.code}`);
      console.log(
        "\nAjoute cette variable dans Render (Environment) pour figer ce lien, sinon le serveur la retrouve tout seul a chaque demarrage."
      );
      return;
    }
    if (created.status === 401 || created.status === 403) {
      console.error(
        `❌ Permission refusee sur #${channel.name} (HTTP ${created.status}). ` +
          'Donne au bot la permission "Create Invite" (ou "Manage Server") puis relance.'
      );
      process.exit(1);
    }
  }
  console.error('❌ Creation impossible: verifie les permissions du bot sur les salons texte.');
  process.exit(1);
})();
