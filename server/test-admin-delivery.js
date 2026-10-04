'use strict';
const {settleResponse}=require('./tests/script-jobs');
const assert = require('node:assert/strict');
const { startFixture } = require('./tests/platform-fixture');
async function run() {
  const f = await startFixture();
  const controls = require('./src/services/site-controls');
  let checks = 0;
  const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('OK ' + label); };
  async function req(route, method = 'GET', body, cookie = f.cookies[0], extra = {}) {
    const response = await fetch(f.base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: f.base }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return settleResponse(f,response,cookie);
  }
  try {
    const created = await req('/api/platform/projects', 'POST', { name: 'Staff delivery checks' });
    const id = created.data.project.id, token = created.data.apiToken;
    check((await req('/api/platform/projects/' + id + '/script', 'PUT', { content: 'return "staff-delivery"' })).status === 200, 'Prepare a checked private build');
    const issued = await req('/api/platform/projects/' + id + '/licenses', 'POST', { count: 1 });
    const license = issued.data.licenses[0];
    const validate = () => req('/api/platform/v1/check', 'POST', { projectId: id, key: license.key, hwid: 'staff-device-01', loadScript: true }, '');
    const publish = () => req('/api/catalog/projects/' + id, 'PUT', { title: 'Staff delivery', description: '', game: 'Universal', accessMode: 'free', published: true });
    check((await publish()).status === 200 && (await req('/api/catalog/scripts/' + id + '/source', 'GET', undefined, '')).status === 200, 'Prepare a public snapshot');
    check((await validate()).status === 200, 'An active project delivers the licensed build');

    await f.pool.query('UPDATE developer_projects SET hidden=true WHERE id=$1', [id]);
    check((await req('/api/catalog/scripts/' + id, 'GET', undefined, '')).status === 404 && (await req('/api/catalog/scripts/' + id + '/source', 'GET', undefined, '')).status === 404, 'Hidden publication is inaccessible by detail and source URLs');
    check((await publish()).status === 403, 'The owner cannot bypass a staff publication restriction');
    check((await validate()).status === 200, 'Hiding the publication preserves private licensed delivery');
    await f.pool.query('UPDATE developer_projects SET hidden=false,disabled=true WHERE id=$1', [id]);
    for (const route of ['/api/platform/v1/loader/', '/api/platform/v1/sdk/', '/api/platform/public/projects/']) {
      check((await req(route + id, 'GET', undefined, '')).status === 404, 'Disabled project denies ' + route);
    }
    check((await validate()).data.reason === 'project_unavailable', 'Disabled project denies existing keys');
    check((await req('/api/platform/v1/projects/' + id + '/licenses', 'POST', { count: 1 }, '', { Authorization: 'Bearer ' + token })).status === 403, 'Disabled project denies server token issuance');
    check((await req('/api/platform/projects/' + id + '/licenses', 'POST', { count: 1 })).status === 403, 'Disabled project denies owner issuance');
    check((await req('/api/platform/checkpoints/' + id + '/start', 'POST', {}, '')).status === 404, 'Disabled project cannot start a checkpoint');
    check((await req('/api/catalog/scripts', 'GET', undefined, '')).data.total === 0, 'Disabled project disappears from the public catalogue');
    await f.pool.query('UPDATE developer_projects SET disabled=false WHERE id=$1', [id]);

    await f.pool.query('UPDATE developer_licenses SET revoked=true,admin_revoked=true WHERE id=$1', [license.id]);
    check((await req('/api/platform/projects/' + id + '/licenses/' + license.id + '/restore', 'POST', {})).status === 404, 'Owner cannot undo an administrator license revocation');
    check((await validate()).data.reason === 'revoked', 'Staff revocation remains effective');
    await f.pool.query('UPDATE developer_licenses SET revoked=false,admin_revoked=false WHERE id=$1', [license.id]);

    await f.pool.query('UPDATE developer_accounts SET banned_at=$1 WHERE discord_id=$2', [new Date(), '900000000000000001']);
    check((await req('/api/platform/projects')).status === 401, 'A banned account loses access with its existing browser cookie');
    check((await validate()).data.reason === 'project_unavailable', 'A banned publisher cannot deliver through a public key API');
    check((await req('/api/catalog/scripts/' + id + '/source', 'GET', undefined, '')).status === 404, 'A banned publisher cannot distribute its public snapshot');
    await f.pool.query('UPDATE developer_accounts SET banned_at=NULL,suspended_until=$1 WHERE discord_id=$2', [new Date(Date.now() + 3600000), '900000000000000001']);
    check((await req('/api/platform/projects')).status === 401 && (await validate()).data.reason === 'project_unavailable', 'Suspension affects browser and token-independent delivery');
    await f.pool.query('UPDATE developer_accounts SET suspended_until=NULL WHERE discord_id=$1', ['900000000000000001']);

    await f.pool.query("UPDATE developer_site_settings SET maintenance_enabled=true,announcement_enabled=true,announcement_message='<img src=x onerror=alert(1)>' WHERE id=1");
    controls.invalidateSettings();
    check((await req('/api/platform/v1/loader/' + id, 'GET', undefined, '')).status === 503 && (await req('/api/catalog/scripts', 'GET', undefined, '')).status === 503, 'Maintenance stops the catalogue and platform APIs');
    const config = await req('/api/site/config', 'GET', undefined, '');
    check(config.data.maintenance && config.data.announcement === '<img src=x onerror=alert(1)>', 'Announcement is returned as plain text rather than injected markup');
    check((await req('/privacy', 'GET', undefined, '')).status === 200 && (await req('/api/auth/options', 'GET', undefined, '')).status === 200, 'Legal information and sign-in remain accessible during maintenance');
    await f.pool.query('UPDATE developer_site_settings SET maintenance_enabled=false WHERE id=1');
    controls.invalidateSettings();
    check((await validate()).status === 200, 'Ending maintenance restores active project delivery');
    console.log('Admin delivery: ' + checks + ' checks passed.');
  } finally { controls.invalidateSettings(); await f.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
