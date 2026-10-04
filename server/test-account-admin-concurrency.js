'use strict';
const assert = require('node:assert/strict');
const { startFixture } = require('./tests/platform-fixture');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Administrator operation did not reach the expected transaction lock.')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function run() {
  const f = await startFixture(), auth = require('./src/services/developer-auth');
  const ids = ['900000000000000001', '900000000000000002'];
  const nativeConnect = f.pool.connect.bind(f.pool);
  const gates = [];
  let lock, nextGate, waiting;
  // pg-mem ignores PostgreSQL locks. This adapter exercises the actual HTTP
  // handlers and queries while modelling only the shared transaction guard;
  // it does not claim to test PostgreSQL's lock manager or rollback behavior.
  f.pool.connect = async () => {
    const backing = await nativeConnect(), nativeQuery = backing.query.bind(backing), nativeRelease = backing.release.bind(backing);
    let held = false;
    const unlock = () => { if (held) { held = false; const old = lock; lock = null; old.resolve(); } };
    return {
      async query(sql, args) {
        if (sql === 'SELECT pg_advisory_xact_lock(1732517019,1)' && !held) {
          while (lock) { if (waiting) waiting.resolve(); await lock.promise; }
          lock = defer(); held = true;
          if (nextGate) { const gate = nextGate; nextGate = null; gate.entered.resolve(); await gate.resume.promise; }
        }
        const result = await nativeQuery(sql, args);
        if (sql === 'COMMIT' || sql === 'ROLLBACK') unlock();
        return result;
      },
      release() { unlock(); nativeRelease(); },
    };
  };
  async function request(route, method, cookie, body) {
    const response = await fetch(f.base + route, { method, headers: { Origin: f.base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  try {
    delete process.env.MODERATION_ADMIN_IDS;
    for (const id of ids) await f.pool.query("INSERT INTO developer_moderation_roles(account_id,role) VALUES($1,'admin')", [id]);
    nextGate = { entered: defer(), resume: defer() }; const firstGate = nextGate;
    gates.push(firstGate);
    const deleteFirst = request('/api/account', 'DELETE', f.cookies[0], { confirmation: 'DELETE' });
    await bounded(firstGate.entered.promise); waiting = defer();
    const demoteSecond = request('/api/account', 'DELETE', f.cookies[1], { confirmation: 'DELETE' });
    await bounded(waiting.promise); firstGate.resume.resolve();
    const [deleted, denied] = await Promise.all([deleteFirst, demoteSecond]);
    assert.equal(deleted.status, 200); assert.equal(denied.status, 409); assert.equal(denied.data.code,'LAST_ADMIN');
    assert.equal(Number((await f.pool.query("SELECT count(*) AS total FROM developer_moderation_roles WHERE role='admin'")).rows[0].total), 1);
    console.log('OK A concurrent self deletion sees the remaining administrator and cannot remove it.');

    await f.pool.query('INSERT INTO developer_accounts(discord_id,username) VALUES($1,$2)', [ids[0], 'Restored fixture account']);
    await f.pool.query("INSERT INTO developer_moderation_roles(account_id,role) VALUES($1,'admin')", [ids[0]]);
    f.cookies[0]=auth.COOKIE+'='+await auth.createSession(ids[0]);
    nextGate = { entered: defer(), resume: defer() }; const secondGate = nextGate;
    gates.push(secondGate);
    const demoteFirst = request('/api/account', 'DELETE', f.cookies[1], { confirmation: 'DELETE' });
    await bounded(secondGate.entered.promise); waiting = defer();
    const deleteSecond = request('/api/account', 'DELETE', f.cookies[0], { confirmation: 'DELETE' });
    await bounded(waiting.promise); secondGate.resume.resolve();
    const [demoted, preserved] = await Promise.all([demoteFirst, deleteSecond]);
    assert.equal(demoted.status, 200); assert.equal(preserved.status, 409); assert.equal(preserved.data.code, 'LAST_ADMIN');
    assert.equal(Number((await f.pool.query("SELECT count(*) AS total FROM developer_moderation_roles WHERE role='admin'")).rows[0].total), 1);
    console.log('OK Reversing concurrent self-deletion order also preserves the last administrator.');
    console.log('Account admin concurrency: both orderings passed with an explicit fixture transaction-lock adapter; PostgreSQL lock concurrency is not simulated.');
  } finally {
    for (const gate of gates) gate.resume.resolve();
    if (lock) lock.resolve();
    f.pool.connect = nativeConnect; delete process.env.MODERATION_ADMIN_IDS; await f.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
