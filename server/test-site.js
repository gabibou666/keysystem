'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { createSiteStats, CACHE_TTL_MS, HIDDEN } = require('./src/services/site-stats');
const { startFixture } = require('./tests/platform-fixture');

async function run() {
  let checks = 0;
  const check = (ok, label) => { assert.ok(ok, label); checks++; console.log('OK ' + label); };

  let time = 0, calls = 0, release;
  const firstQuery = new Promise(resolve => { release = resolve; });
  const counts = { projects: '10', licenses: '100', scripts: '3' };
  const cached = createSiteStats({ pool: { query: async () => { calls++; return firstQuery; } }, now: () => time });
  check(calls === 0, 'Constructing public stats never queries or wakes the database');
  const visitors = Array.from({ length: 12 }, () => cached.get());
  check(calls === 1, 'Concurrent visitors share a single database query');
  release({ rows: [counts] });
  const snapshots = await Promise.all(visitors);
  check(snapshots.every(row => row === snapshots[0]) && snapshots[0].visible && snapshots[0].licenses === 100, 'Concurrent visitors receive the same real aggregate snapshot');
  time = CACHE_TTL_MS - 1;
  await cached.get();
  check(calls === 1, 'Counts remain cached for ten minutes');
  time = CACHE_TTL_MS;
  await cached.get();
  check(calls === 2, 'First visitor after expiry refreshes counts');

  for (const key of ['projects', 'licenses', 'scripts']) {
    const low = { ...counts, [key]: 0 };
    const service = createSiteStats({ pool: { query: async () => ({ rows: [low] }) } });
    check(JSON.stringify(await service.get()) === JSON.stringify(HIDDEN), 'A low ' + key + ' count hides every value');
  }
  let failures = 0;
  const unavailable = createSiteStats({ pool: { query: async () => { failures++; throw Error('PRIVATE_DATABASE_URL'); } }, now: () => 0 });
  check(JSON.stringify(await unavailable.get()) === JSON.stringify(HIDDEN), 'Database errors produce hidden values without diagnostics');
  await unavailable.get();
  check(failures === 1, 'Database failure is cached, avoiding repeated wakeups');
  const invalid = createSiteStats({ pool: { query: async () => ({ rows: [{ ...counts, licenses: '9007199254740993' }] }) } });
  check(!(await invalid.get()).visible, 'Unsafe or malformed aggregate counts are hidden');
  let slowCalls = 0, slowTime = 0, settleSlow;
  const slowWork = new Promise(resolve => { settleSlow = resolve; });
  const slow = createSiteStats({ pool: { query: () => { slowCalls++; return slowWork; } }, now: () => slowTime, queryTimeoutMs: 10 });
  check(JSON.stringify(await slow.get()) === JSON.stringify(HIDDEN), 'An unresolved database connection returns hidden statistics within the request deadline');
  slowTime = CACHE_TTL_MS;
  await slow.get();
  check(slowCalls === 1, 'Expired cache never queues another request behind an unresolved connection');
  settleSlow({ rows: [counts] });
  await new Promise(resolve => setImmediate(resolve));

  const names = ['SUPPORT_EMAIL', 'DISCORD_URL', 'STATUS_URL', 'LEGAL_NAME', 'LEGAL_EMAIL', 'LEGAL_ADDRESS'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  names.forEach(name => { delete process.env[name]; });
  const f = await startFixture();
  async function request(route, options = {}) {
    const response = await fetch(f.base + route, options);
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  try {
    const config = await request('/api/site/config');
    check(config.status === 200 && JSON.stringify(config.data) === JSON.stringify({ supportEmail: '', discordUrl: '', statusUrl: '', changelogUrl: '/changelog', legalName: '', legalEmail: '', legalAddress: '', ...require('./src/services/site-controls').DEFAULTS }), 'Unconfigured support and legal values are empty with a working local changelog link');
    process.env.SUPPORT_EMAIL = ' support@example.com ';
    process.env.DISCORD_URL = 'https://discord.gg/KdQwN99C9w';
    process.env.STATUS_URL = 'https://status.example.com/';
    const configured = (await request('/api/site/config')).data;
    check(configured.supportEmail === 'support@example.com' && configured.discordUrl === process.env.DISCORD_URL && configured.statusUrl === process.env.STATUS_URL, 'Public configuration contains only validated support values');
    process.env.SUPPORT_EMAIL = 'support@example.com?subject=injected';
    process.env.DISCORD_URL = 'javascript:alert(1)';
    process.env.STATUS_URL = 'https://user:PRIVATE_SECRET@example.com/status';
    check(Object.entries((await request('/api/site/config')).data).filter(([key]) => ['supportEmail','discordUrl','statusUrl','legalName','legalEmail','legalAddress'].includes(key)).every(([, value]) => value === ''), 'Unsafe email, script scheme and URL credentials are rejected');
    process.env.DISCORD_URL = 'http://external.example.com';
    process.env.STATUS_URL = 'http://127.0.0.1:3215/status';
    const local = (await request('/api/site/config')).data;
    check(local.discordUrl === '' && local.statusUrl === process.env.STATUS_URL, 'HTTP links are restricted to loopback development hosts');
    process.env.LEGAL_NAME = ' Publisher <script>plain text</script> ';
    process.env.LEGAL_EMAIL = ' privacy@example.com ';
    process.env.LEGAL_ADDRESS = ' Publisher address to be completed ';
    const legal = (await request('/api/site/config')).data;
    check(legal.legalName === 'Publisher <script>plain text</script>' && legal.legalEmail === 'privacy@example.com' && legal.legalAddress === 'Publisher address to be completed', 'Legal configuration is public text with a validated email');
    process.env.LEGAL_NAME = 'x'.repeat(201);
    process.env.LEGAL_EMAIL = 'privacy@example.com?body=injected';
    process.env.LEGAL_ADDRESS = 'Private\ncontrol character';
    const invalidLegal = (await request('/api/site/config')).data;
    check(!invalidLegal.legalName && !invalidLegal.legalEmail && !invalidLegal.legalAddress, 'Oversized or unsafe legal values fall back to visible placeholders');

    const hub = randomUUID(), hiddenHub = randomUUID();
    await f.pool.query("INSERT INTO developer_hubs(id,owner_id,slug,name,published_at) VALUES($1,$2,'site-visible','Visible creator',now())", [hub, '900000000000000001']);
    await f.pool.query("INSERT INTO developer_hubs(id,owner_id,slug,name) VALUES($1,$2,'site-hidden','PRIVATE_CREATOR')", [hiddenHub, '900000000000000002']);
    const projects = [];
    for (let i = 0; i < 10; i++) {
      const id = randomUUID(); projects.push(id);
      await f.pool.query('INSERT INTO developer_projects(id,owner_id,name,api_token_hash) VALUES($1,$2,$3,$4)', [id, '900000000000000001', 'PRIVATE_PROJECT_' + i, 'PRIVATE_TOKEN_' + i]);
      if (i === 9) continue;
      await f.pool.query("INSERT INTO developer_scripts(project_id,content_enc,content_iv,validated,obfuscated,safety_status) VALUES($1,'PRIVATE_CIPHER','PRIVATE_IV',true,true,$2)", [id, i === 5 ? 'quarantined' : i === 1 ? 'approved' : 'clear']);
      const hash=require('./src/services/crypto').sha256('fixture-'+i),moderation=require('./src/services/moderation');
      await f.pool.query('UPDATE developer_scripts SET validated=$2,build_hash=$3,safety_hash=$3,scanner_version=$4 WHERE project_id=$1',[id,i!==6,hash,require('./src/services/script-safety').SCANNER_VERSION]);
      await moderation.recordAutomaticClear(f.pool,id,'current',1,hash);
      await f.pool.query("INSERT INTO developer_listings(project_id,hub_id,title,published_at,snapshot_validated,snapshot_obfuscated,safety_status) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, i === 8 ? hiddenHub : hub, 'Visible script ' + i, i === 3 ? null : new Date(), i !== 6, i !== 7, i === 4 ? 'quarantined' : 'clear']);
    }
    for (let i = 0; i < 100; i++) await f.pool.query('INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), projects[i % projects.length], 'PRIVATE_KEY_' + i, 'ah_test', 'PRIVATE_LICENSE_NOTE', new Date(Date.now() + 86400000)]);
    const publicStats = await request('/api/site/stats');
    check(publicStats.status === 200 && JSON.stringify(publicStats.data) === JSON.stringify({ visible: true, projects: 10, licenses: 100, scripts: 3 }), 'Database-backed stats count only automatically verified eligible scripts and exclude historical approvals');
    await f.pool.query("UPDATE developer_script_revalidation SET scanner_version='static-luau-3' WHERE project_id=$1 AND target_kind='current'",[projects[2]]);
    check(!(await createSiteStats({pool:f.pool}).get()).visible,'Old scanner proofs cannot inflate public script statistics');
    await f.pool.query('UPDATE developer_script_revalidation SET scanner_version=$2 WHERE project_id=$1',[projects[2],require('./src/services/script-safety').SCANNER_VERSION]);
    check(publicStats.headers.get('cache-control') === 'no-store' && !JSON.stringify(publicStats.data).includes('PRIVATE'), 'Public statistics expose only aggregate numbers and avoid a second cache lifetime');
    await f.pool.query('UPDATE developer_hubs SET published_at=NULL WHERE id=$1', [hub]);
    check((await request('/api/site/stats')).data.visible, 'Repeated HTTP stats are served from the ten-minute cache');
    check(!(await createSiteStats({ pool: f.pool }).get()).visible, 'Withdrawing the public profile hides real statistics when the cache refreshes');
    await f.pool.query('UPDATE developer_hubs SET published_at=now() WHERE id=$1', [hub]);

    const report = { projectId: projects[0], category: 'misleading', description: 'The published description needs review.' };
    const reportOptions = (body = report, cookie = f.cookies[0], origin = f.base) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    check((await request('/api/moderation/reports', reportOptions(report, ''))).status === 401, 'Script reports require a signed-in account');
    check((await request('/api/moderation/reports', reportOptions(report, f.cookies[0], 'https://foreign.example'))).status === 403, 'Script reports reject a foreign origin');
    check((await request('/api/moderation/reports', reportOptions({ ...report, category: 'invalid' }))).status === 400, 'Report reasons use a strict allowlist');
    check((await request('/api/moderation/reports', reportOptions({ ...report, description: 'x'.repeat(501) }))).status === 400, 'Report messages have a bounded length');
    check((await request('/api/moderation/reports', reportOptions({ ...report, projectId: projects[3] }))).status === 404, 'Private draft scripts cannot receive public reports');
    const created = await request('/api/moderation/reports', reportOptions());
    const repeated = await request('/api/moderation/reports', reportOptions());
    check(created.status === 200 && repeated.data.duplicate && repeated.data.id === created.data.id, 'Existing backend stores script reports and keeps duplicates idempotent');
    const stored = (await f.pool.query('SELECT reason,description FROM developer_moderation_reports WHERE id=$1', [created.data.id])).rows[0];
    check(stored.reason === report.category && stored.description === report.description, 'Report reason and message are persisted for moderators');
    console.log('Public site: ' + checks + ' checks passed.');
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await f.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
