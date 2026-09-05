// Infos jeux Roblox: PlaceId -> nom, icone, stats (via APIs publiques Roblox)
// Cache 24h en DB (game_info) pour eviter le rate-limit Roblox.

const pool = require('../db');

const CACHE_TTL_HOURS = 24;

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

module.exports = { getGameInfo };
