// Infos jeux Roblox: PlaceId -> nom, icone, stats (via APIs publiques Roblox)
// Cache 24h en DB (game_info) pour eviter le rate-limit Roblox.

const pool = require('../db');

const CACHE_TTL_HOURS = 24;

// Batch users Roblox: UserIds -> { id, name, displayName, hasPremium } (POST, 100 max/call)
async function fetchRobloxUsers(userIds) {
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 100) {
    chunks.push(userIds.slice(i, i + 100));
  }
  const out = new Map();
  for (const chunk of chunks) {
    const res = await fetch('https://users.roblox.com/v1/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'KeySystem/1.0' },
      body: JSON.stringify({ userIds: chunk.map((n) => parseInt(n, 10)) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    for (const u of data?.data || []) {
      out.set(u.id, u);
    }
  }
  return out;
}

async function httpGetJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'KeySystem/1.0' },
  });
  if (!res.ok) throw new Error(`roblox api ${res.status}`);
  return res.json();
}

// Recupere (ou met a jour le cache) les infos d'un jeu
async function getGameInfo(placeId) {
  placeId = parseInt(placeId, 10);
  if (!Number.isFinite(placeId) || placeId <= 0) return null;

  // 1. Cache valide?
  const { rows } = await pool.query(
    `SELECT name, icon_url, playing, visits FROM game_info
     WHERE place_id = $1 AND updated_at > now() - make_interval(hours => $2)`,
    [placeId, CACHE_TTL_HOURS]
  );
  if (rows[0] && rows[0].name) {
    return {
      placeId,
      name: rows[0].name,
      iconUrl: rows[0].icon_url,
      playing: rows[0].playing,
      visits: rows[0].visits,
    };
  }

  // 2. APIs Roblox: PlaceId -> universeId
  try {
    const place = await httpGetJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    const universeId = place?.universeId;
    if (!universeId) throw new Error('no universeId');

    // universeId -> details (nom, playing, visits)
    const details = await httpGetJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    const game = details?.data?.[0];
    if (!game || !game.name) throw new Error('no game details');

    // universeId -> icone
    let iconUrl = null;
    try {
      const icon = await httpGetJson(
        `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=256x256&format=Png&isCircular=false`
      );
      iconUrl = icon?.data?.[0]?.imageUrl || null;
    } catch {}

    const info = {
      placeId,
      name: game.name,
      iconUrl,
      playing: game.playing ?? null,
      visits: game.visits ?? null,
    };

    // 3. Met a jour le cache
    await pool.query(
      `INSERT INTO game_info (place_id, name, icon_url, playing, visits, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (place_id) DO UPDATE SET name = $2, icon_url = $3, playing = $4, visits = $5, updated_at = now()`,
      [info.placeId, info.name, info.iconUrl, info.playing, info.visits]
    );

    return info;
  } catch (e) {
    // API echoue: renvoie le cache expire s'il existe (mieux que rien)
    const stale = await pool.query(
      'SELECT name, icon_url, playing, visits FROM game_info WHERE place_id = $1',
      [placeId]
    );
    if (stale.rows[0]) {
      return {
        placeId,
        name: stale.rows[0].name,
        iconUrl: stale.rows[0].icon_url,
        playing: stale.rows[0].playing,
        visits: stale.rows[0].visits,
      };
    }
    // Fallback: nom technique
    return { placeId, name: `Game ${placeId}`, iconUrl: null, playing: null, visits: null };
  }
}

// Recupere les infos utilisateurs avec cache 24h (pseudo, avatar headshot)
async function getUsersInfo(userIds) {
  const ids = [...new Set(userIds.map((n) => parseInt(n, 10)).filter(Number.isFinite))];
  if (!ids.length) return [];

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const cached = await pool.query(
    `SELECT user_id, username, display, avatar_url, has_premium FROM user_cache
     WHERE user_id IN (${placeholders}) AND updated_at > now() - make_interval(hours => ${CACHE_TTL_HOURS})`,
    ids
  );
  const cacheMap = new Map(cached.rows.map((r) => [parseInt(r.user_id, 10), r]));

  const missing = ids.filter((id) => !cacheMap.has(id));
  if (missing.length) {
    try {
      const users = await fetchRobloxUsers(missing);
      // Avatars headshot (100 max/call)
      const avatarChunks = [];
      for (let i = 0; i < missing.length; i += 100) avatarChunks.push(missing.slice(i, i + 100));
      const avatarMap = new Map();
      for (const chunk of avatarChunks) {
        try {
          const res = await fetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunk.join(',')}&size=150x150&format=Png&isCircular=false`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (res.ok) {
            const d = await res.json();
            for (const a of d?.data || []) {
              if (a.imageUrl) avatarMap.set(a.targetId, a.imageUrl);
            }
          }
        } catch {}
      }
      for (const id of missing) {
        const u = users.get(id);
        const info = {
          userId: id,
          username: u ? u.name : `user_${id}`,
          display: u ? (u.displayName || u.name) : `User ${id}`,
          avatarUrl: avatarMap.get(id) || null,
          hasPremium: u ? !!u.hasPremium : false,
        };
        cacheMap.set(id, info);
        await pool.query(
          `INSERT INTO user_cache (user_id, username, display, avatar_url, has_premium, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (user_id) DO UPDATE SET username = $2, display = $3, avatar_url = $4, has_premium = $5, updated_at = now()`,
          [info.userId, info.username, info.display, info.avatarUrl, info.hasPremium]
        );
      }
    } catch {
      // API down: renvoie du cache expire si dispo, sinon fallback anonyme
      const stale = await pool.query(
        `SELECT user_id, username, display, avatar_url, has_premium FROM user_cache WHERE user_id IN (${placeholders})`,
        ids
      );
      for (const r of stale.rows) {
        if (!cacheMap.has(parseInt(r.user_id, 10))) {
          cacheMap.set(parseInt(r.user_id, 10), r);
        }
      }
      for (const id of missing) {
        if (!cacheMap.has(id)) {
          cacheMap.set(id, { userId: id, username: `user_${id}`, display: `User ${id}`, avatarUrl: null, hasPremium: false });
        }
      }
    }
  }

  return ids.map((id) => {
    const c = cacheMap.get(id) || { userId: id, username: `user_${id}`, display: `User ${id}`, avatarUrl: null, hasPremium: false };
    return {
      userId: parseInt(c.user_id ?? c.userId, 10),
      username: c.username,
      display: c.display || c.username,
      avatarUrl: c.avatar_url || c.avatarUrl || null,
      hasPremium: c.has_premium ?? c.hasPremium ?? false,
    };
  });
}

module.exports = { getGameInfo, getUsersInfo };
