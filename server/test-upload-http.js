'use strict';
const assert = require('node:assert/strict');
const { startFixture } = require('./tests/platform-fixture');
const { randomUUID } = require('crypto');

async function run() {
  const fixture = await startFixture();
  const queue = require('./src/services/publication-queue'), enqueue = queue.enqueue;
  let captured;
  let checks = 0;
  const check = (condition, label) => { assert.ok(condition, label); checks++; };
  async function request(path, body, cookie = fixture.cookies[0], method = 'PUT') {
    const response = await fetch(fixture.base + path, {
      method, headers: { 'Content-Type': 'application/json', Origin: fixture.base,
        ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  }
  try {
    const created = await request('/api/platform/projects', { name: 'Upload boundary fixture' }, fixture.cookies[0], 'POST');
    assert.equal(created.status, 201);
    const id = created.data.project.id;
    const path = '/api/platform/projects/' + id + '/script';
    const largeBody = { content: '--' + 'x'.repeat(3 * 1024 * 1024) + '\nreturn 1' };
    check((await request(path, largeBody, '')).status === 401,
      'Large unauthenticated uploads are refused before JSON parsing');
    check((await request(path, largeBody, fixture.cookies[1])).status === 404,
      'Large uploads to another owner project are refused before JSON parsing');
    check(Number((await fixture.pool.query('SELECT count(*) AS total FROM developer_script_jobs')).rows[0].total) === 0,
      'Rejected preflight requests create no source or job');
    const prefix = '--', suffix = '\nreturn 1\n', max = 8 * 1024 * 1024;
    const source = prefix + '"'.repeat(max - Buffer.byteLength(prefix + suffix)) + suffix;
    check(Buffer.byteLength(source) === max && Buffer.byteLength(JSON.stringify({ content: source })) > max,
      'The boundary fixture exercises JSON escaping beyond the source byte size');
    // pg-mem interpolates parameters into SQL text and its parser overflows on
    // an 11 MiB encrypted literal. PostgreSQL uses parameter values separately.
    // Capture only this boundary admission; normal-sized durable storage is
    // covered by test-script-jobs, and production-sized DB writes need staging.
    queue.enqueue = async input => {
      if (Buffer.byteLength(input.content || '') !== max) return enqueue(input);
      captured = input;
      const build = await require('./src/services/script-builder').build(input.content);
      assert.equal(build.code, source);
      return { id: randomUUID(), status: 'queued', originalSizeBytes: max, obfuscate: false };
    };
    const accepted = await request(path, { content: source, filename: 'boundary.lua' });
    check(accepted.status === 202 && accepted.data.queued, 'An exact 8 MiB source passes the authenticated upload parser: ' + JSON.stringify(accepted.data));
    check(captured?.content === source && captured.filename === 'boundary.lua' && captured.projectId === id && captured.ownerId === '900000000000000001',
      'The parsed source, filename and authenticated ownership reach admission without truncation');
    queue.enqueue = enqueue;
    check((await request(path, { content: source + 'x' })).status === 400, 'A source one byte over the limit is rejected');
    check((await request(path, { content: '--' + 'é'.repeat(max / 2) })).status === 400,
      'UTF-8 byte count rejects multibyte source even when character count is below the limit');
    const generic = await request('/api/catalog/projects/' + id, { description: 'x'.repeat(3 * 1024 * 1024) });
    check(generic.status === 413, 'The larger parser does not expand other API request limits');
    console.log('Upload HTTP: ' + checks + ' checks passed, including real 8 MiB parser/compiler and authenticated preflight. Boundary DB admission is captured because of the pg-mem SQL parser size limit.');
  } finally { queue.enqueue = enqueue; await fixture.close(); }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
