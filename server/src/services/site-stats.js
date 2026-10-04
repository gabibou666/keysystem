'use strict';
const {proofJoins,listingVerified}=require('./script-publication-policy');

const CACHE_TTL_MS = 10 * 60 * 1000;
const QUERY_TIMEOUT_MS = 3000;
const MINIMUMS = Object.freeze({ projects: 10, licenses: 100, scripts: 3 });
const HIDDEN = Object.freeze({ visible: false, projects: null, licenses: null, scripts: null });

// The catalogue's publication and moderation rules also apply to this count.
// Private uploads, withdrawn profiles and quarantined releases are not scripts
// published on the platform. Aggregate projects/licences contain no identifiers.
const COUNTS_SQL = `SELECT
  (SELECT count(*) FROM developer_projects) AS projects,
  (SELECT count(*) FROM developer_licenses) AS licenses,
  (SELECT count(*) FROM developer_listings l
    JOIN developer_hubs h ON h.id=l.hub_id
    JOIN developer_projects p ON p.id=l.project_id
    JOIN developer_scripts s ON s.project_id=p.id
    JOIN developer_accounts a ON a.discord_id=p.owner_id
    ${proofJoins}
    WHERE l.published_at IS NOT NULL AND h.published_at IS NOT NULL
      AND ${listingVerified}
      AND p.disabled=false AND p.hidden=false AND p.deleted_at IS NULL
      AND s.disabled=false AND s.deleted_at IS NULL
      AND a.banned_at IS NULL AND (a.suspended_until IS NULL OR a.suspended_until<=now())) AS scripts`;

function createSiteStats({ pool, now = Date.now, queryTimeoutMs = QUERY_TIMEOUT_MS } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A database pool is required.');
  let cached = HIDDEN, expiresAt = 0, pending = null, activeQuery = null;

  async function refresh() {
    let result = HIDDEN, timeout;
    try {
      const work = Promise.resolve(pool.query({ text: COUNTS_SQL, query_timeout: queryTimeoutMs }));
      activeQuery = work;
      work.finally(() => { if (activeQuery === work) activeQuery = null; }).catch(() => {});
      // Bound connection acquisition too: pg's query_timeout starts only once
      // a client is acquired. Slow public statistics must not hold HTTP open.
      const deadline = new Promise(resolve => { timeout = setTimeout(() => resolve({ rows: [] }), queryTimeoutMs); });
      const row = (await Promise.race([work, deadline])).rows[0] || {};
      const counts = Object.fromEntries(Object.keys(MINIMUMS).map(key => [key, Number(row[key])]));
      if (Object.entries(MINIMUMS).every(([key, min]) => Number.isSafeInteger(counts[key]) && counts[key] >= min)) {
        result = Object.freeze({ visible: true, ...counts });
      }
    } catch {
      // Failure is cached too: a busy or unavailable DB must not be retried for
      // every visitor. No raw error, private record or small count is returned.
    } finally { clearTimeout(timeout); }
    cached = result;
    expiresAt = now() + CACHE_TTL_MS;
    return result;
  }

  return {
    get() {
      if (now() < expiresAt) return Promise.resolve(cached);
      // Concurrent visitors share one query. There is deliberately no timer:
      // an idle site, keepalive or health probe never refreshes these counts.
      // Do not enqueue another database request if an earlier connection is
      // still unresolved, even after the hidden response's cache expires.
      if (!pending && activeQuery) return Promise.resolve(HIDDEN);
      if (!pending) pending = refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = { createSiteStats, CACHE_TTL_MS, QUERY_TIMEOUT_MS, MINIMUMS, HIDDEN };
