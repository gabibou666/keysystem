'use strict';
// Regression tests use an isolated database and mocked provider responses.
const assert = require('node:assert/strict');
const { startFixture } = require('./tests/platform-fixture');
async function run() {
  const f = await startFixture();
  let checks = 0;
  const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('OK ' + label); };
  async function req(path, method = 'GET', body, cookie = f.cookies[0], extra = {}) {
    const response = await fetch(f.base + '/api/platform' + path, { method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers,
      data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
  }
  const cookies = headers => headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  const providerFetch = global.fetch;
  const providerOptions = [];
  let duringProviderStart = null;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://work.ink/_api/')) {
      providerOptions.push(options);
      if (duringProviderStart && String(url).includes('/override?')) {
        const callback = duringProviderStart; duringProviderStart = null; await callback();
      }
    }
    return providerFetch(url, options);
  };
  try {
    const created = await req('/projects', 'POST', { name: 'Security regressions' });
    const id = created.data.project.id, apiToken = created.data.apiToken;
    const key = (await req('/projects/' + id + '/licenses', 'POST', {})).data.licenses[0].key;
    await req('/projects/' + id + '/script', 'PUT', { content: 'return "protected-source"' });
    const missing = await req('/v1/check', 'POST', { projectId: id, key, loadScript: true }, '');
    check(missing.data.reason === 'hwid_required' && !missing.data.script, 'Missing HWID cannot download a device-bound script');
    const objectHwid = await req('/v1/check', 'POST', { projectId: id, key, hwid: {}, loadScript: true }, '');
    check(objectHwid.data.reason === 'hwid_required' && !objectHwid.data.script, 'Non-string HWID cannot bypass device binding');
    await req('/v1/check', 'POST', { projectId: id, key, hwid: 'original-device', loadScript: true }, '');
    const stolen = await req('/v1/check', 'POST', { projectId: id, key, hwid: 'another-device', loadScript: true }, '');
    check(stolen.data.reason === 'bound_to_other_device' && !stolen.data.script, 'Different device cannot obtain script content');
    check((await req('/projects/' + id + '/checkpoints', 'PUT', { provider: 'toString' })).status === 400,
      'Inherited object properties cannot masquerade as checkpoint providers');
    const settings = { provider: 'workink', linkUrl: 'https://work.ink/creator-link', linkId: '10345' };
    await req('/projects/' + id + '/checkpoints', 'PUT', settings);
    const first = await req('/checkpoints/' + id + '/start', 'POST', {}, '');
    const firstCookie = cookies(first.headers);
    await req('/checkpoints/' + id + '/return?session=' + first.data.session + '&token=validtoken123&hash=irrelevant', 'GET', undefined, firstCookie);
    check((await req('/checkpoints/' + first.data.session + '/status', 'GET', undefined, firstCookie)).data.status === 'completed',
      'Valid provider token completes its original session');
    const second = await req('/checkpoints/' + id + '/start', 'POST', {}, '');
    const secondCookie = cookies(second.headers);
    // The fake provider deliberately accepts a consumed token twice, reproducing
    // upstream concurrency or replay weaknesses independently of our database.
    const replayReturn = await req('/checkpoints/' + id + '/return?session=' + second.data.session + '&token=validtoken123&hash=different', 'GET', undefined, secondCookie);
    check(replayReturn.headers.get('location').includes('checkpoint=failed'), 'Replayed provider proof returns an explicit failed checkpoint');
    const replay = await req('/checkpoints/' + second.data.session + '/status', 'GET', undefined, secondCookie);
    check(replay.data.status === 'pending' && replay.data.completed === 0, 'Same provider token cannot advance a second session');
    await req('/projects/' + id + '/checkpoints', 'PUT', { ...settings, linkUrl: 'https://work.ink/new-link' });
    check((await req('/checkpoints/' + second.data.session + '/status', 'GET', undefined, secondCookie)).status === 410,
      'Provider configuration change invalidates pending sessions');
    check((await req('/checkpoints/' + first.data.session + '/status', 'GET', undefined, firstCookie)).data.status === 'completed',
      'Provider configuration change preserves an already issued key');
    const retained = await f.pool.query('SELECT receipt_id FROM developer_checkpoint_receipts WHERE project_id=$1', [id]);
    check(retained.rows.length === 1, 'Changing configuration retains consumed provider receipts');
    duringProviderStart = () => req('/projects/' + id + '/checkpoints', 'PUT', { ...settings, linkUrl: 'https://work.ink/rotated-during-start' });
    const changed = await req('/checkpoints/' + id + '/start', 'POST', {}, '');
    check(changed.status === 409, 'An in-flight provider start cannot create a session with stale configuration');
    check(providerOptions.length > 0 && providerOptions.every(options => options.redirect === 'error'),
      'Provider HTTP calls reject redirects carrying tokens or credentials');
    const originalQuery = f.pool.query;
    let rotateDuringLookup = true;
    f.pool.query = async function (sql, args) {
      const result = await originalQuery.call(this, sql, args);
      if (rotateDuringLookup && sql === 'SELECT * FROM developer_projects WHERE id=$1 AND api_token_hash=$2') {
        rotateDuringLookup = false;
        await originalQuery.call(this, 'UPDATE developer_projects SET api_token_hash=$1 WHERE id=$2', ['rotated-before-issuance-lock', id]);
      }
      return result;
    };
    try {
      const raced = await req('/v1/projects/' + id + '/licenses', 'POST', {}, '', { Authorization: 'Bearer ' + apiToken });
      check(raced.status === 401, 'API-token rotation before issuance lock prevents license creation');
    } finally { f.pool.query = originalQuery; }
    console.log(`Platform security: ${checks} checks passed.`);
  } finally { await f.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
