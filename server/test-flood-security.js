'use strict';
const assert = require('node:assert/strict');
// No real webhook calls during flood tests.
require.cache[require.resolve('./src/services/notify')] = { exports: { notifyDiscord: async () => {} } };
delete process.env.IP_HEADER;
const flood = require('./src/services/antiddos');
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('OK ' + label); };
function request(ip, path = '/api/platform/me', xff = 'attacker-controlled') {
  let passed = false, status, body;
  const headers = {};
  flood.antiDdosMiddleware({ ip, path, headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '127.0.0.1' } }, {
    setHeader: (name, value) => { headers[name] = value; },
    status: value => { status = value; return { json: value => { body = value; } }; },
  }, () => { passed = true; });
  return { passed, status, body, headers };
}
check(flood.getClientIp({ ip: '999.999.999.999', headers: {} }) === null, 'Invalid IP strings cannot create tracker entries');
for (let i = 0; i < 95; i++) request('8.8.4.4', '/api/platform/me', 'spoof-' + i);
check(request('8.8.4.4').status === 429, 'Changing forwarded header does not bypass resolved-IP flood ban');
check(request('8.8.4.4', '/healthz').passed, 'Health probe remains available during an IP ban');
flood.unbanIP('8.8.4.4');
for (let i = 0; i < 10000; i++) assert.ok(request(`11.0.${i >> 8}.${i & 255}`).passed);
const full = request('12.1.2.3');
check(full.status === 429 && flood.getStats().currentlyTrackedIPs === 10000, 'Rotating source IPs cannot grow flood tracker memory indefinitely');
check(request('12.1.2.3', '/healthz').passed, 'Health probe remains available at tracker capacity');
flood.unbanIP('11.0.0.0');
check(request('12.1.2.3').passed, 'Tracker resumes accepting clients once capacity is freed');
console.log(`Flood security: ${checks} checks passed without network traffic.`);
