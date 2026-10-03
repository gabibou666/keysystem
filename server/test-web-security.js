'use strict';
const assert = require('node:assert/strict');
const { startFixture } = require('./tests/platform-fixture');
async function run() {
  const f = await startFixture(); let checks = 0;
  const auth = require('./src/services/developer-auth');
  const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('OK ' + label); };
  let address = 10;
  async function post(route, body, headers = {}) {
    return fetch(f.base + '/api/auth/' + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: f.base,
      'X-Forwarded-For': '203.0.113.' + address++, ...headers,
    }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  }
  try {
    f.app.set('trust proxy', 1);
    const page = await fetch(f.base + '/');
    const csp = page.headers.get('content-security-policy');
    check(csp.includes("script-src 'self'") && csp.includes("script-src-attr 'none'") && !csp.includes('unsafe-eval') && !csp.includes('highrevenueformat'), 'Developer pages restrict scripts to own site');
    check(csp.includes("frame-ancestors 'none'") && page.headers.get('x-frame-options') === 'DENY', 'Developer pages cannot be framed for clickjacking');
    check(page.headers.get('referrer-policy') === 'no-referrer', 'Developer pages do not forward sensitive URLs as referrers');
    check(page.headers.get('permissions-policy').includes('camera=()'), 'Unused browser device permissions disabled');
    check((await fetch(f.base + '/hub')).status===404, 'Removed historical player page is unavailable');
    const badCookie = await fetch(f.base + '/api/platform/projects', { headers: { Cookie: f.cookies[0] + '; unrelated=%E0%A4%A' } });
    check(badCookie.status === 200, 'Malformed unrelated cookie does not break authenticated requests');
    check((await post('login', '{')).status === 400, 'Malformed JSON rejected as client error');
    check((await post('login', [])).status === 400, 'JSON arrays cannot reach account handlers');
    const large = await post('login', { email: 'test@example.com', password: 'x'.repeat(17000) });
    check(large.status === 413 && !(await large.text()).includes('x'.repeat(100)), 'Large authentication bodies rejected without reflecting passwords');
    check((await post('login', {}, { 'Content-Encoding': 'gzip' })).status === 415, 'Compressed authentication bodies rejected before decompression');
    check((await post('login', { email: 'test@example.com', password: 'password' }, { Origin: 'https://attacker.example' })).status === 403, 'Cross-origin account writes rejected');
    const originalHash = auth.passwordHash; let hashes = 0;
    auth.passwordHash = async (...args) => { hashes++; return originalHash(...args); };
    try {
      check((await post('reset', { token: 'a'.repeat(64), password: 'new-long-password-123' })).status === 400 && hashes === 0, 'Invalid reset token cannot trigger expensive password hashing');
    } finally { auth.passwordHash = originalHash; }
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await post('login', { email: attempt % 2 ? ' GUESS@EXAMPLE.COM ' : 'guess@example.com', password: 'wrong-password' });
      assert.equal(response.status, 401);
    }
    const blocked = await post('login', { email: 'guess@example.com', password: 'wrong-password' });
    check(blocked.status === 429 && Number(blocked.headers.get('retry-after')) > 0, 'Account-targeted guessing is limited across changing IP addresses');
    check((await post('login', { email: 'different@example.com', password: 'wrong-password' })).status === 401, 'Throttled address does not block another account');
    const { passwordWork } = require('./src/services/password-work');
    const work = await Promise.allSettled(Array.from({ length: 3 }, () => passwordWork('test-password', 'test-salt')));
    check(work.filter(r => r.status === 'fulfilled').length === 2 && work.some(r => r.status === 'rejected' && r.reason.code === 'AUTH_BUSY'), 'Password flood cannot fill an unbounded worker queue');
    check((await passwordWork('test-password', 'test-salt')).length === 64, 'Password service recovers after bounded work completes');
    const login = await fetch(f.base + '/api/discord/login', { redirect: 'manual' });
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const missingCookie = await fetch(f.base + '/api/discord/callback?code=test&state=' + encodeURIComponent(state), { redirect: 'manual' });
    check(missingCookie.headers.get('location') === '/dashboard?login=invalid', 'Discord developer flow requires the originating browser');
    console.log(`Web security: ${checks} checks passed with no production traffic.`);
  } finally { await f.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
