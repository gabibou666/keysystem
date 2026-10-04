'use strict';
const {settleResponse}=require('./tests/script-jobs');

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { chromium } = require('@playwright/test');

// Every browser scenario talks to an isolated real fixture in its own process.
// No production credentials, external support requests or mocked UI responses.
async function fixtureChild() {
  const { startFixture } = require('./tests/platform-fixture');
  const f = await startFixture();
  const request = async (route, method, body) => {
    const r = await fetch(f.base + route, {
      method, headers: { Cookie: f.cookies[0], Origin: f.base, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result=await settleResponse(f,r,f.cookies[0]);
    assert.ok(result.status<400,JSON.stringify(result.data));
    return result.data;
  };
  const projectId = (await request('/api/platform/projects', 'POST', { name: 'Isolated browser test project' })).project.id;
  await request('/api/platform/projects/' + projectId + '/script', 'PUT', { content: 'return "Isolated browser test release"' });
  await request('/api/catalog/projects/' + projectId, 'PUT', { title: 'Isolated browser test release', description: 'A release stored only in the browser test database.', game: '', accessMode: 'free', published: true });
  process.send({ base: f.base, cookie: f.cookies[0], projectId });
  process.on('message', async message => {
    if (message.type === 'reports') {
      const reports = (await f.pool.query('SELECT reason,description FROM developer_moderation_reports WHERE project_id=$1', [projectId])).rows;
      process.send({ type: 'reports', reports });
    }
  });
  process.once('SIGTERM', async () => { await f.close(); process.exit(0); });
}

async function startIsolated(env = {}) {
  const child = fork(__filename, ['--fixture'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'test', SUPPORT_EMAIL: '', DISCORD_URL: '', STATUS_URL: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
  const info = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Browser fixture startup timed out. ' + stderr)); }, 20000);
    child.once('message', message => { clearTimeout(timeout); resolve(message); });
    child.once('exit', code => { clearTimeout(timeout); reject(Error('Browser fixture failed: ' + code + ' ' + stderr)); });
  });
  return {
    ...info,
    reports: () => new Promise(resolve => {
      const receive = message => { if (message.type === 'reports') { child.off('message', receive); resolve(message.reports); } };
      child.on('message', receive); child.send({ type: 'reports' });
    }),
    close: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); }),
  };
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const artifacts = path.join(__dirname, '../artifacts/studio');
  fs.mkdirSync(artifacts, { recursive: true });
  let checks = 0;
  const check = (ok, label) => { assert.ok(ok, label); checks++; console.log('OK ' + label); };
  const errors = [], policyErrors = [];
  async function context(locale, width = 1440) {
    const c = await browser.newContext({ locale, viewport: { width, height: width === 360 ? 800 : 1000 }, reducedMotion: 'reduce' });
    await c.addInitScript(() => {
      window.__studioPolicyViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__studioPolicyViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    });
    c.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && /content.security|content security|refused to/i.test(message.text())) policyErrors.push(message.text()); });
    });
    return c;
  }
  async function landing(page, base, language) {
    const config = page.waitForResponse(response => new URL(response.url()).pathname === '/api/site/config' && response.status() === 200);
    await page.goto(base, { waitUntil: 'networkidle' });if(await page.locator('#cookieConsentReject').isVisible()) await page.locator('#cookieConsentReject').click();
    await config;
    await page.waitForFunction(expected => document.documentElement.lang === expected, language);
    await page.locator('#languageSelect').waitFor();
  }
  async function noOverflow(page, label) {
    const details = await page.evaluate(() => {
      const width = innerWidth;
      const outside = [...document.querySelectorAll('body *')].filter(element => {
        if (element.closest('[hidden]') || getComputedStyle(element).position === 'fixed' || element.classList.contains('sr-only') || element.classList.contains('skip-link')) return false;
        const r = element.getBoundingClientRect(), style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && (r.right > width + 1 || r.left < -1);
      }).slice(0, 8).map(element => element.tagName + '.' + element.className);
      return { scroll: document.documentElement.scrollWidth, width, outside };
    });
    check(details.scroll <= details.width + 1 && details.outside.length === 0, label + ': no horizontal overflow ' + JSON.stringify(details));
  }

  let empty, configured;
  try {
    empty = await startIsolated();
    const english = await context('en-US');
    const page = await english.newPage();
    await landing(page, empty.base, 'en');
    check((await page.locator('[data-i18n="hero.title1"]').textContent()) === 'Your scripts.', 'English is the default landing language');
    check(await page.locator('[data-contact="email"]:visible,[data-contact="discord"]:visible,[data-contact="status"]:visible').count() === 0, 'Empty support environment values expose no optional links');
    check(await page.locator('footer a[href="/changelog"]:visible').count() === 1, 'Changelog is available without optional configuration');
    check(!(await page.locator('#siteStatistics').isVisible()), 'Low real activity hides the statistics line');
    for (const route of ['/api/site/config', '/api/site/stats', '/changelog']) {
      const r = await page.request.get(empty.base + route);
      check(r.status() === 200 && r.headers()['x-frame-options'] === 'DENY' && r.headers()['referrer-policy'] === 'no-referrer' && r.headers()['content-security-policy'].includes("script-src-attr 'none'"), 'Platform browser headers apply to ' + route);
    }
    const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    check(schema['@type'] === 'SoftwareApplication' && schema.offers.price === '0' && schema.url === empty.base + '/', 'SoftwareApplication JSON-LD uses the real public URL and free plan');
    check((await page.locator('meta[name="twitter:card"]').getAttribute('content')) === 'summary_large_image' && (await page.locator('meta[name="theme-color"]').getAttribute('content')) === '#0b1210', 'Large social card and browser theme color are declared');
    const social = await page.locator('meta[property="og:image"]').getAttribute('content');
    check(social === await page.locator('meta[name="twitter:image"]').getAttribute('content'), 'Open Graph and Twitter use the same social image');
    const size = await page.evaluate(async src => {
      const img = new Image(); img.src = src; await img.decode(); return { width: img.naturalWidth, height: img.naturalHeight };
    }, social);
    check(size.width === 1200 && size.height === 630, 'The real social image measures 1200 × 630');
    for (const selector of ['link[rel="icon"][sizes="any"]', 'link[rel="icon"][sizes="32x32"]', 'link[rel="apple-touch-icon"]']) {
      const url = await page.locator(selector).getAttribute('href');
      check((await page.request.get(new URL(url, empty.base).href)).status() === 200, 'Favicon asset is served: ' + selector);
    }
    check(await page.locator('.release-workflow li').count() === 4 && await page.locator('[data-demo]').count() === 0, 'Only one four-step workflow remains');
    const summary = page.locator('.faq-list details').nth(2).locator('summary');
    await summary.focus(); await page.keyboard.press('Enter');
    check(await summary.evaluate(element => element.parentElement.open), 'FAQ opens with the keyboard');
    const focus = await summary.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: parseFloat(getComputedStyle(element).outlineWidth) }));
    check(focus.style !== 'none' && focus.width >= 2, 'Keyboard focus is visibly styled');
    await page.keyboard.press('Enter');
    check(!(await summary.evaluate(element => element.parentElement.open)), 'FAQ closes with the keyboard');
    await page.locator('#languageSelect').selectOption('fr');
    await page.locator('[data-i18n="hero.title1"]').getByText('Vos scripts.', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    check(await page.locator('html').getAttribute('lang') === 'fr', 'Manual language selection persists after reload');
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(artifacts, 'landing-fr-desktop.png'), fullPage: false });
    await page.locator('#languageSelect').selectOption('en');
    await page.locator('[data-i18n="hero.title1"]').getByText('Your scripts.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 800 });
    await noOverflow(page, 'English landing at 360 px');
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(artifacts, 'landing-en-360.png'), fullPage: true });
    await page.locator('#languageSelect').selectOption('fr');
    await page.locator('[data-i18n="hero.title1"]').getByText('Vos scripts.', { exact: true }).waitFor();
    await noOverflow(page, 'French landing at 360 px');
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(artifacts, 'landing-fr-360.png'), fullPage: true });
    check((await page.evaluate(() => window.__studioPolicyViolations)).length === 0, 'Landing JSON-LD and local assets cause no CSP violations');
    const french = await context('fr-FR', 360), frenchPage = await french.newPage();
    await landing(frenchPage, empty.base, 'fr');
    check(await frenchPage.locator('#languageSelect').inputValue() === 'fr', 'French browser preferences select French automatically');
    const other = await context('es-ES'), otherPage = await other.newPage();
    await landing(otherPage, empty.base, 'en');
    check(await otherPage.locator('#languageSelect').inputValue() === 'en', 'Other browser languages fall back to English');
    await english.close(); await french.close(); await other.close();
    await empty.close(); empty = null;

    configured = await startIsolated({ SUPPORT_EMAIL: 'support@example.test', DISCORD_URL: 'https://discord.gg/KdQwN99C9w', STATUS_URL: 'https://status.example.test/' });
    const owner = await context('en-US', 360);
    const cookieAt = configured.cookie.indexOf('=');
    await owner.addCookies([{ name: configured.cookie.slice(0, cookieAt), value: configured.cookie.slice(cookieAt + 1), url: configured.base }]);
    const reportPage = await owner.newPage();
    await landing(reportPage, configured.base, 'en');
    for (const [key, href] of [['email', 'mailto:support@example.test'], ['discord', 'https://discord.gg/KdQwN99C9w'], ['status', 'https://status.example.test/']]) {
      const link = reportPage.locator('footer [data-contact="' + key + '"]');
      check(await link.isVisible() && await link.getAttribute('href') === href, 'Configured footer displays the correct ' + key + ' support destination');
    }
    await reportPage.goto(configured.base + '/scripts', { waitUntil: 'networkidle' });if(await reportPage.locator('#cookieConsentReject').isVisible()) await reportPage.locator('#cookieConsentReject').click();
    await reportPage.locator('.catalog-script-card').waitFor();
    await noOverflow(reportPage, 'Published scripts directory at 360 px');
    const trigger = reportPage.locator('#catalogGrid .report-trigger').first();
    await trigger.click();
    const dialog = reportPage.locator('#scriptReportDialog');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('select').selectOption('misleading');
    await dialog.locator('textarea').fill('Browser fixture: the public description needs review.');
    await dialog.locator('button[type="submit"]').click();
    await reportPage.getByText('Report sent to the moderators. Thank you for helping the community.', { exact: true }).waitFor();
    const reports = await configured.reports();
    check(reports.length === 1 && reports[0].reason === 'misleading' && reports[0].description === 'Browser fixture: the public description needs review.', 'Directory report form sends and persists the real reason and message');
    await reportPage.screenshot({ path: path.join(artifacts, 'scripts-report-360.png'), fullPage: true });
    await owner.close();
    check(errors.length === 0 && policyErrors.length === 0, 'Browser pages have no script errors or CSP console errors: ' + JSON.stringify([...errors, ...policyErrors]));
    console.log('Studio UI: ' + checks + ' checks passed. Screenshots: ' + artifacts);
  } finally {
    await browser.close();
    if (empty) await empty.close();
    if (configured) await configured.close();
  }
}

if (process.argv.includes('--fixture')) fixtureChild().catch(error => { console.error(error); process.exitCode = 1; });
else run().catch(error => { console.error(error); process.exitCode = 1; });
