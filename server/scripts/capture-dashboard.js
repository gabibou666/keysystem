'use strict';
// Developer-only capture of the actual UI with an isolated, disposable database.
// No .env is loaded; startFixture injects pg-mem instead of the production pool.
// Usage from server/: node scripts/capture-dashboard.js [absolute-output.png]
// Requires npm dev dependencies and `npx playwright install chromium`.
// Export the resulting PNG as WebP (1536/1440 px and 768 px) for the landing.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { startFixture } = require('../tests/platform-fixture');

async function capture() {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../../artifacts/dashboard-reference.png'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fixture = await startFixture(0, false);
  let browser;
  try {
    async function api(endpoint, method = 'GET', body) {
      const response = await fetch(fixture.base + '/api/platform' + endpoint, {
        method,
        headers: { Cookie: fixture.cookies[0], Origin: fixture.base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.ok(response.ok && data.success !== false, `Demo API request failed: ${method} ${endpoint}`);
      return data;
    }
    await fixture.pool.query('UPDATE developer_accounts SET username=$1 WHERE discord_id=$2', ['Studio North', '900000000000000001']);
    for (const demo of [{ name: 'Orbit utilities', count: 24 }, { name: 'Prism toolkit', count: 8 }]) {
      const created = await api('/projects', 'POST', { name: demo.name });
      await api('/projects/' + created.project.id + '/licenses', 'POST', { count: demo.count, durationHours: 72, note: 'Local demonstration data' });
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'en-US', deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const separator = fixture.cookies[0].indexOf('=');
    await context.addCookies([{ name: fixture.cookies[0].slice(0, separator), value: fixture.cookies[0].slice(separator + 1), url: fixture.base, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.base + '/dashboard', { waitUntil: 'networkidle' });if(await page.locator('#cookieConsentReject').isVisible()) await page.locator('#cookieConsentReject').click();
    await page.locator('#workspaceView').waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: 'Orbit utilities', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Prism toolkit', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('#projectCount').textContent(), '2');
    assert.equal(await page.locator('#licenseCount').textContent(), '32');
    assert.deepEqual(errors, [], 'Actual dashboard must load without JavaScript errors');
    await page.screenshot({ path: output, fullPage: false, animations: 'disabled' });
    console.log('Actual dashboard capture: ' + output);
    console.log('1440x950 px / 2 local demo projects / 32 issued demo licenses / isolated database');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
capture().catch(error => { console.error(error.message); process.exitCode = 1; });
