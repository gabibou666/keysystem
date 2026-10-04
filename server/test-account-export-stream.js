'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { startFixture } = require('./tests/platform-fixture');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition) {
  const end = Date.now() + 2000;
  while (!condition()) { if (Date.now() > end) throw Error('Export cleanup did not finish.'); await delay(10); }
}
async function run() {
  const f = await startFixture();
  const data = require('./src/services/account-data'), auth = require('./src/services/developer-auth');
  const originalExport = data.exportAccount, originalConnect = f.pool.connect.bind(f.pool);
  const open = new Set(); let checks = 0;
  const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('OK ' + label); };
  function start(cookie) {
    return new Promise((resolve, reject) => {
      const request = http.get(f.base + '/api/account/export', { headers: { Cookie: cookie } }, response => {
        response.on('error', () => {}); response.pause(); resolve({ request, response });
      });
      request.on('error', reject); open.add(request); request.once('close', () => open.delete(request));
    });
  }
  try {
    const thirdId = 'export-stream-third';
    await f.pool.query('INSERT INTO developer_accounts(discord_id,username) VALUES($1,$2)', [thirdId, 'Third export developer']);
    const thirdCookie = 'ah_session=' + await auth.createSession(thirdId);
    const started = [], closed = [];
    // Keep actual authenticated HTTP responses open so admission and disconnect
    // behavior are exercised, without a one-minute test or any real DB/network.
    data.exportAccount = async function* (accountId, tokenHash, options) {
      started.push(accountId);
      try {
        yield '{"streamTest":';
        await new Promise((resolve, reject) => {
          const signal = options.signal;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      } finally { closed.push(accountId); }
    };
    const first = await start(f.cookies[0]);
    check(first.response.statusCode === 200, 'An authenticated export begins');
    const duplicate = await fetch(f.base + '/api/account/export', { headers: { Cookie: f.cookies[0] } });
    check(duplicate.status === 429 && (await duplicate.json()).code === 'EXPORT_BUSY' && started.length === 1, 'One account cannot reserve another export connection');
    const second = await start(f.cookies[1]);
    check(second.response.statusCode === 200, 'A second account can export concurrently');
    const full = await fetch(f.base + '/api/account/export', { headers: { Cookie: thirdCookie } });
    check(full.status === 429 && (await full.json()).code === 'EXPORT_BUSY' && started.length === 2, 'Only two exports may reserve connections globally');
    first.request.destroy(); await until(() => closed.length === 1);
    const again = await start(f.cookies[0]);
    check(again.response.statusCode === 200 && started.length === 3, 'Disconnect closes the generator and frees its admission slot');
    second.request.destroy(); again.request.destroy(); await until(() => closed.length === 3);
    data.exportAccount = originalExport;
    const real = await fetch(f.base + '/api/account/export', { headers: { Cookie: thirdCookie } });
    check(real.status === 200 && (await real.json()).account.id === thirdId, 'Admission recovers for a complete real account export');

    let delayedResolve, returned = 0;
    f.pool.connect = () => new Promise(resolve => { delayedResolve = resolve; });
    const pending = originalExport(thirdId, auth.hash(thirdCookie.slice('ah_session='.length)), { acquireMs: 30, durationMs: 200 });
    await assert.rejects(pending.next(), { code: 'EXPORT_TIMEOUT', status: 504 });
    check(true, 'A stalled pool checkout has a bounded timeout');
    delayedResolve({ release() { returned++; } }); await until(() => returned === 1);
    check(returned === 1, 'A checkout arriving after timeout is returned immediately');

    let destroyed = false;
    f.pool.connect = async () => ({ query() { return new Promise(() => {}); }, release(force) { destroyed = force === true; } });
    const blocked = originalExport(thirdId, 'test-token-hash', { queryMs: 30, durationMs: 200 });
    await assert.rejects(blocked.next(), { code: 'EXPORT_TIMEOUT', status: 504 });
    check(destroyed, 'A stalled query destroys its client instead of returning an unfinished query to the pool');

    const releases = [];
    const clientReleases = new WeakMap();
    f.pool.connect = async () => {
      const client = await originalConnect();
      if (!clientReleases.has(client)) clientReleases.set(client, client.release.bind(client));
      const release = clientReleases.get(client);
      client.release = force => { releases.push(force === true); release(force); }; return client;
    };
    const controller = new AbortController();
    const interrupted = originalExport(thirdId, auth.hash(thirdCookie.slice('ah_session='.length)), { signal: controller.signal });
    await interrupted.next(); controller.abort(new Error('Synthetic client disconnected.'));
    check(releases.length === 1 && releases[0], 'Client cancellation frees a connection even while the generator is suspended');
    await interrupted.return(); check(releases.length === 1, 'Cancelled clients are released once');
    const stalled = originalExport(thirdId, auth.hash(thirdCookie.slice('ah_session='.length)), { durationMs: 50 });
    await stalled.next(); await until(() => releases.length === 2);
    check(releases[1], 'The total deadline frees a connection even when a consumer stops reading');
    await stalled.return(); check(releases.length === 2, 'A timed-out suspended generator does not release its client twice');
    console.log(`Account export streaming: ${checks} checks passed using isolated fixtures.`);
  } finally {
    for (const request of open) request.destroy();
    data.exportAccount = originalExport; f.pool.connect = originalConnect;
    await f.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
