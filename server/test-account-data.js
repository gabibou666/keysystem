'use strict';
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { randomUUID } = require('crypto');
const { startFixture } = require('./tests/platform-fixture');
async function run() {
  const f = await startFixture(); let checks = 0;
  const check = (ok, label) => { assert.ok(ok, label); checks++; console.log('OK ' + label); };
  const ids = ['900000000000000001', '900000000000000002'];
  const service = require('./src/services/account-data'), crypto = require('./src/services/crypto'), auth = require('./src/services/developer-auth'), moderation = require('./src/services/moderation');
  async function request(route, method = 'GET', body, cookie = f.cookies[0], origin = f.base, json = true) {
    const r = await fetch(f.base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(json && body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json(), headers: r.headers };
  }
  try {
    check((await request('/api/account/export', 'GET', undefined, '')).status === 401, 'Anonymous export is rejected');
    check((await request('/api/account', 'DELETE', { confirmation: 'DELETE' }, '')).status === 401, 'Anonymous account deletion is rejected');
    await f.pool.query('UPDATE developer_accounts SET email=$1,password_hash=$2,email_verified=true,terms_accepted_at=now(),terms_version=$3,privacy_version=$3 WHERE discord_id=$4', ['owner@example.test', 'PASSWORD_SECRET', '2026-10-03', ids[0]]);
    await f.pool.query("INSERT INTO developer_identities(provider,subject,account_id) VALUES('discord','OWN_IDENTITY',$1),('google','FOREIGN_IDENTITY',$2)", ids);
    await f.pool.query("INSERT INTO developer_email_tokens(token_hash,account_id,purpose,expires_at) VALUES('EMAIL_TOKEN_SECRET',$1,'reset',now()+interval '1 hour')", [ids[0]]);
    const projects = [], hubs = [];
    for (let i = 0; i < 2; i++) {
      const project = randomUUID(), hub = randomUUID(); projects.push(project); hubs.push(hub);
      await f.pool.query('INSERT INTO developer_projects(id,owner_id,name,description,api_token_hash,lootlabs_token_enc,lootlabs_token_iv,checkpoint_secret_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [project, ids[i], i ? 'FOREIGN_PRIVATE_PROJECT' : 'Own project', i ? 'FOREIGN_PRIVATE_DESCRIPTION' : 'Own description', 'API_TOKEN_SECRET', 'PROVIDER_SECRET_CIPHER', 'PROVIDER_SECRET_IV', 'CALLBACK_SECRET_HASH']);
      const source = i ? 'return "FOREIGN_PRIVATE_SOURCE"' : 'return "OWN_STORED_BUILD"', build = crypto.encryptAES(source), hash=crypto.sha256(source);
      await f.pool.query("INSERT INTO developer_scripts(project_id,content_enc,content_iv,validated,obfuscated,safety_status,build_hash,safety_hash,scanner_version) VALUES($1,$2,$3,true,true,'clear',$4,$4,$5)", [project, build.enc, build.iv, hash, require('./src/services/script-safety').SCANNER_VERSION]);
      await moderation.recordAutomaticClear(f.pool,project,'current',1,hash);
      await f.pool.query('INSERT INTO developer_hubs(id,owner_id,slug,name,published_at) VALUES($1,$2,$3,$4,now())', [hub, ids[i], 'account-test-' + i, i ? 'FOREIGN_PROFILE_NAME' : 'Own profile']);
      await f.pool.query("INSERT INTO developer_listings(project_id,hub_id,title,published_at,snapshot_content_enc,snapshot_content_iv,snapshot_validated,snapshot_obfuscated,safety_status,access_mode) VALUES($1,$2,$3,now(),$4,$5,true,true,'clear','free')", [project, hub, i ? 'Foreign public release' : 'Own release', build.enc, build.iv]);
      await f.pool.query('UPDATE developer_listings SET script_version=1,safety_hash=$2 WHERE project_id=$1',[project,hash]);
      await moderation.recordAutomaticClear(f.pool,project,'free_snapshot',1,hash);
    }
    const licenses = [];
    for (let i = 0; i < 123; i++) {
      const id = randomUUID(); licenses.push(id);
      await f.pool.query('INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at,hwid_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, projects[0], 'LICENSE_HASH_SECRET_' + i, 'ah_prefix', 'Own licence note', new Date(Date.now() + 86400000), 'HWID_SECRET']);
    }
    const foreignLicense = randomUUID();
    await f.pool.query("INSERT INTO developer_licenses(id,project_id,key_hash,key_prefix,note,expires_at) VALUES($1,$2,'FOREIGN_LICENSE_HASH','ah_other','FOREIGN_PRIVATE_NOTE',now()+interval '1 day')", [foreignLicense, projects[1]]);
    await f.pool.query("INSERT INTO developer_events(project_id,license_id,success,reason,executor) VALUES($1,$2,true,'valid','fixture executor'),($3,$4,false,'FOREIGN_EVENT_REASON','FOREIGN_EXECUTOR')", [projects[0], licenses[0], projects[1], foreignLicense]);
    const checkpoint = randomUUID();
    await f.pool.query("INSERT INTO developer_checkpoints(id,project_id,browser_hash,ip_hash,tasks_required,tasks_done,duration_hours,key_enc,key_iv,provider_reference,return_proof_hash) VALUES($1,$2,'BROWSER_SECRET','IP_SECRET',1,1,24,'CHECKPOINT_KEY_SECRET','CHECKPOINT_IV_SECRET','REFERENCE_SECRET','RETURN_PROOF_SECRET')", [checkpoint, projects[0]]);
    await f.pool.query('INSERT INTO developer_checkpoint_receipts(project_id,receipt_id,checkpoint_id) VALUES($1,$2,$3)', [projects[0], 'PROOF_RECEIPT_SECRET', checkpoint]);
    await f.pool.query('INSERT INTO developer_checkpoint_proof_uses(proof_hash) VALUES($1)', ['d'.repeat(64)]);
    await f.pool.query("INSERT INTO developer_registration_limits(quota_key,window_start,account_count) VALUES('network:unlinked-test-hmac',now(),1)");
    const pending = crypto.encryptAES('return "OWN_PENDING_BUILD"');
    // Historical human-review payload remains exportable after the queue closes.
    await f.pool.query("INSERT INTO developer_moderation_submissions(id,project_id,owner_id,base_version,base_hash,version,content_enc,content_iv,build_hash,target_mode,builder_version,scanner_version,findings,status) VALUES($1,$2,$3,1,$4,2,$5,$6,$7,'universal','fixture','fixture',$8::jsonb,'pending')",[randomUUID(),projects[0],ids[0],'a'.repeat(64),pending.enc,pending.iv,'b'.repeat(64),JSON.stringify([{rule:'dynamic.loader',severity:'review',line:1}])]);
    const ownReport = randomUUID(), otherReport = randomUUID(), foreignReport = randomUUID();
    await f.pool.query("INSERT INTO developer_moderation_reports(id,project_id,reporter_id,reason,description) VALUES($1,$2,$3,'misleading','Own submitted report'),($4,$5,$6,'privacy','OTHER_REPORT_PRIVATE'),($7,$2,$6,'other','FOREIGN_OWNER_REPORT')", [ownReport, projects[1], ids[0], otherReport, projects[0], ids[1], foreignReport]);
    await moderation.audit(f.pool, { actorId: ids[0], projectId: projects[0], action: 'upload.clear', note: 'OWN_AUDIT_PRIVATE_NAME', hash: 'a'.repeat(64), version: 1 });
    await moderation.audit(f.pool, { actorId: ids[1], projectId: projects[0], action: 'project.quarantined', note: 'OTHER_AUDIT_PRIVATE_NOTE', hash: 'a'.repeat(64), version: 1 });
    await moderation.audit(f.pool, { actorId: ids[1], subjectId: ids[0], action: 'role.updated', note: 'SUBJECT_PRIVATE_NOTE', role: 'user' });
    await moderation.audit(f.pool, { actorId: ids[1], projectId: projects[1], action: 'upload.clear', note: 'FOREIGN_UNRELATED_NOTE', hash: 'c'.repeat(64), version: 1 });
    const subjectAudit = (await f.pool.query("SELECT actor_id,subject_id FROM developer_moderation_audit WHERE action='role.updated'")).rows[0];
    check(subjectAudit.actor_id === ids[1] && subjectAudit.subject_id === ids[0], 'Audit preserves different actor and subject identities before erasure');

    const exported = await request('/api/account/export');
    const jsonText = JSON.stringify(exported.data);
    check(exported.status === 200 && exported.headers.get('content-disposition').startsWith('attachment;') && exported.headers.get('cache-control') === 'no-store', 'Export is a private JSON download');
    check(exported.data.account.email === 'owner@example.test' && exported.data.account.termsAcceptedAt && exported.data.account.termsVersion === '2026-10-03', 'Account identity and accepted legal versions are exported');
    check(exported.data.identities.length === 1 && exported.data.identities[0].subject === 'OWN_IDENTITY', 'Only the account’s own OAuth identity is exported');
    check(exported.data.projects.length === 1 && exported.data.projects[0].id === projects[0] && exported.data.profile.length === 1, 'Export is scoped to the account’s own projects and profile');
    check(exported.data.licenses.length === 123 && exported.data.validations.length === 1, 'Paged export includes all licences and validation history without truncation');
    check(exported.data.scripts[0].source === 'return "OWN_STORED_BUILD"' && exported.data.publications[0].source === 'return "OWN_STORED_BUILD"' && exported.data.moderationSubmissions[0].source === 'return "OWN_PENDING_BUILD"', 'Stored builds, published snapshots and owned pending builds are exported decrypted');
    check(exported.data.sessions[0].current && exported.data.emailTokens[0].purpose === 'reset', 'Session and email-token metadata is provided without tokens');
    check(exported.data.reportsSubmitted.length === 1 && exported.data.reportsSubmitted[0].description === 'Own submitted report', 'Export includes only reports submitted by this account');
    check(!/PASSWORD_SECRET|API_TOKEN_SECRET|PROVIDER_SECRET|CALLBACK_SECRET|LICENSE_HASH_SECRET|HWID_SECRET|BROWSER_SECRET|IP_SECRET|CHECKPOINT_KEY_SECRET|REFERENCE_SECRET|RETURN_PROOF_SECRET|EMAIL_TOKEN_SECRET/.test(jsonText), 'Credential, checkpoint, browser, IP and device secrets are excluded');
    check(!/FOREIGN_PRIVATE|FOREIGN_IDENTITY|FOREIGN_PROFILE_NAME|FOREIGN_EVENT_REASON|FOREIGN_EXECUTOR|OTHER_REPORT_PRIVATE|OTHER_AUDIT_PRIVATE_NOTE|SUBJECT_PRIVATE_NOTE|FOREIGN_UNRELATED_NOTE/.test(jsonText), 'Other tenants’ private data and other people’s report/moderation notes are excluded');
    const targeted = await request('/api/account/export?accountId=' + ids[1]);
    check(targeted.data.account.id === ids[0], 'A query parameter cannot target another account’s export');
    const other = await request('/api/account/export', 'GET', undefined, f.cookies[1]);
    check(other.data.account.id === ids[1] && other.data.projects[0].id === projects[1] && !JSON.stringify(other.data).includes('OWN_STORED_BUILD'), 'The second tenant receives only its own export');
    check((await request('/api/account', 'DELETE', { confirmation: 'DELETE' }, f.cookies[0], 'https://foreign.example')).status === 403, 'Deletion rejects a foreign origin');
    check((await request('/api/account', 'DELETE', { confirmation: 'DELETE' }, f.cookies[0], '')).status === 403, 'Deletion requires an explicit same-origin browser request');
    check((await request('/api/account', 'DELETE', { confirmation: 'DELETE' }, f.cookies[0], f.base, false)).status === 415, 'Deletion requires JSON');
    check((await request('/api/account', 'DELETE', { confirmation: 'delete' })).data.code === 'CONFIRMATION_REQUIRED', 'Deletion requires the exact DELETE confirmation');
    check((await request('/api/account', 'DELETE', { confirmation: 'DELETE', accountId: ids[1] })).status === 400, 'Deletion refuses an injected target account identifier');
    await assert.rejects(async () => { const stream = service.exportAccount(ids[0], 'invalid-token'); await stream.next(); }, error => error.code === 'SESSION_REVOKED');
    await assert.rejects(service.deleteAccount(ids[0], 'invalid-token'), error => error.code === 'SESSION_REVOKED');
    check((await f.pool.query('SELECT id FROM developer_projects WHERE id=$1', [projects[0]])).rows.length === 1, 'Session is revalidated inside export/deletion before data changes');
    process.env.MODERATION_ADMIN_IDS = ids[0];
    await assert.rejects(service.deleteAccount(ids[0], auth.hash(f.cookies[0].split('=')[1])), error => error.code === 'LAST_ADMIN');
    delete process.env.MODERATION_ADMIN_IDS;
    await f.pool.query("INSERT INTO developer_moderation_roles(account_id,role) VALUES($1,'admin')", [ids[0]]);
    await assert.rejects(service.deleteAccount(ids[0], auth.hash(f.cookies[0].split('=')[1])), error => error.code === 'LAST_ADMIN');
    await f.pool.query('DELETE FROM developer_moderation_roles WHERE account_id=$1', [ids[0]]);
    check(true, 'Configured and last administrators must arrange replacement before self deletion');
    const checkpointCookie = 'ah_checkpoint_' + 'e'.repeat(64), currentCookie = 'ah_checkpoint_current_' + projects[0];
    const deletion = await request('/api/account', 'DELETE', { confirmation: 'DELETE' }, f.cookies[0] + '; ' + checkpointCookie + '=browser; ' + currentCookie + '=session');
    check(deletion.status === 200 && deletion.data.deleted, 'Confirmed deletion removes the complete account graph');
    check(deletion.headers.getSetCookie().some(cookie => cookie.startsWith('ah_session=;')) && deletion.headers.getSetCookie().some(cookie => cookie.startsWith('ah_registration=;')), 'Deletion clears session and registration cookies');
    check([checkpointCookie, currentCookie].every(name => deletion.headers.getSetCookie().some(cookie => cookie.startsWith(name + '=;') && cookie.includes('Path=/api/platform/checkpoints'))), 'Deletion clears both checkpoint cookie formats at their actual path');
    for (const table of ['developer_accounts', 'developer_identities', 'developer_sessions', 'developer_email_tokens', 'developer_projects', 'developer_hubs', 'developer_scripts', 'developer_listings', 'developer_licenses', 'developer_events', 'developer_checkpoints', 'developer_checkpoint_receipts', 'developer_moderation_submissions', 'developer_moderation_reports']) {
      const rows = (await f.pool.query('SELECT * FROM ' + table)).rows;
      check(!JSON.stringify(rows).includes(ids[0]) && !JSON.stringify(rows).includes(projects[0]), 'No deleted account/project data remains in ' + table);
    }
    check((await f.pool.query('SELECT id FROM developer_projects WHERE id=$1', [projects[1]])).rows.length === 1 && (await f.pool.query('SELECT id FROM developer_licenses WHERE id=$1', [foreignLicense])).rows.length === 1 && (await f.pool.query('SELECT id FROM developer_moderation_reports WHERE id=$1', [foreignReport])).rows.length === 1, 'Other owners’ projects, licences and unrelated reports are preserved');
    check((await f.pool.query('SELECT proof_hash FROM developer_checkpoint_proof_uses')).rows.length === 1 && (await f.pool.query('SELECT quota_key FROM developer_registration_limits')).rows.length === 1, 'Unlinked anti-replay proofs and shared short-lived abuse counters are preserved');
    const journal = (await f.pool.query('SELECT * FROM developer_moderation_audit')).rows;
    check(!JSON.stringify(journal).includes(ids[0]) && !JSON.stringify(journal).includes(projects[0]) && !JSON.stringify(journal).includes('OWN_AUDIT_PRIVATE_NAME') && !JSON.stringify(journal).includes('OTHER_AUDIT_PRIVATE_NOTE') && !JSON.stringify(journal).includes('SUBJECT_PRIVATE_NOTE'), 'Related audit identifiers, free-form notes and fingerprints are erased');
    check(journal.some(row => row.action === 'account.deleted' && row.actor_id === null) && journal.some(row => row.action_note === 'FOREIGN_UNRELATED_NOTE'), 'Anonymous deletion record and other tenants’ unrelated audit history remain');
    await moderation.audit(f.pool, { actorId: ids[0], subjectId: ids[0], projectId: projects[0], action: 'upload.clear', note: 'ERASED_PRIVATE_CONTEXT', hash: 'b'.repeat(64), version: 7 });
    const late = (await f.pool.query("SELECT * FROM developer_moderation_audit WHERE action='upload.clear' AND actor_id IS NULL AND project_id IS NULL")).rows;
    check(late.some(row => row.action_note === '' && row.build_hash === null && row.version === null && row.subject_id === null), 'An audit arriving after deletion cannot recreate identifiers, notes or source fingerprints');
    await assert.rejects(f.pool.query('INSERT INTO developer_moderation_audit(id,actor_id,action) VALUES($1,$2,$3)', [randomUUID(), ids[0], 'auth.login']));
    check(true, 'Database foreign keys also refuse stale identifiers bypassing the audit service');
    f.db.public.none(fs.readFileSync(path.join(__dirname, 'db/migration-account-audit-privacy.sql'), 'utf8'));
    f.db.public.none(fs.readFileSync(path.join(__dirname, 'db/migration-account-audit-privacy.sql'), 'utf8'));
    check((await f.pool.query('SELECT id FROM developer_projects WHERE id=$1', [projects[1]])).rows.length === 1, 'Privacy migration can be repeated without deleting existing resources');
    check((await request('/api/account/export')).status === 401 && (await request('/api/platform/me')).data.loggedIn === false, 'Old sessions cannot export or access the deleted workspace');
    check((await fetch(f.base + '/api/catalog/scripts/' + projects[0])).status === 404 && (await fetch(f.base + '/api/catalog/scripts/' + projects[0] + '/source')).status === 404 && (await fetch(f.base + '/api/platform/v1/loader/' + projects[0])).status === 404, 'Deleted public pages, hosted source and loaders are immediately unavailable');
    console.log('Account data: ' + checks + ' checks passed; pg-mem does not simulate PostgreSQL lock concurrency or rollback.');
  } finally { delete process.env.MODERATION_ADMIN_IDS; await f.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
