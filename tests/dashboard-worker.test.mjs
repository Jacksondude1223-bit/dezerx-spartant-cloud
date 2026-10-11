import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {createWorker} from '../dashboard-worker/index.mjs';
import {store, view} from '../dashboard-worker/store.mjs';
import {runJobs} from '../dashboard-worker/jobs.mjs';
import {hashPassword, seal, open, digest} from '../dashboard-worker/crypto.mjs';
import {bindDashboard, ROUTING_DATABASE, setupDatabase} from '../dashboard-worker/setup.mjs';
import {deployDashboard, verificationSql, verifySchema} from '../dashboard-worker/deploy.mjs';
import {COOKIE} from '../dashboard-worker/auth.mjs';
import {totpCode} from '../dashboard/server.mjs';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../dashboard-worker/migrations/0001_dashboard.sql', import.meta.url), 'utf8'));
  const statement = (sql, values = []) => ({sql, values, bind(...v) {return statement(sql, v);}, async first() {return sqlite.prepare(sql).get(...values) || null;}, async all() {return {success: true, results: sqlite.prepare(sql).all(...values)};}, async run() {const result = sqlite.prepare(sql).run(...values); return {success: true, meta: {changes: result.changes}};}});
  const db = {prepare: sql => statement(sql), withSession: mode => {assert.equal(mode, 'first-primary'); return db;}, batch: async statements => {sqlite.exec('BEGIN'); try {const result = []; for (const x of statements) result.push(await x.run()); sqlite.exec('COMMIT'); return result;} catch (error) {sqlite.exec('ROLLBACK'); throw error;}}};
  return {sqlite, db};
}
const password = 'A-long-dashboard-password!';
const passwordHash = await hashPassword(password);
const license = 'SPARTANCLOUDPLUS_abcdefghijklmnop';
function environment(db) {return {DASHBOARD_DB: db, ASSETS: {fetch: async () => new Response('<html>Dashboard</html>')}, ADMIN_API_SECRET: 'a'.repeat(64), ORIGIN_SECRET: 'o'.repeat(64), DASHBOARD_DATA_KEY: 'd'.repeat(64), DASHBOARD_PASSWORD_HASH: passwordHash, DASHBOARD_USER: 'admin', BASE_DOMAIN: 'load.example.test', INSTANCE_DOMAIN: 'example.test', US_ORIGIN: 'https://node-us.example.test', DE_ORIGIN: 'https://node-de.example.test', DATABASE_MODE: 'us-central'};}
function remote(env, {reply} = {}) {
  const calls = [];
  let tenantId;
  const fetch = async (url, options) => {
    const u = new URL(url), body = options.body ? JSON.parse(options.body) : {}, path = u.pathname;
    const secret = path.startsWith('/admin/') ? env.ADMIN_API_SECRET : env.ORIGIN_SECRET;
    assert.equal(options.headers['x-spartan-signature'], createHmac('sha256', secret).update(`${options.headers['x-spartan-timestamp']}\n${options.method}\n${path}\n${options.body || ''}`).digest('hex'));
    assert.equal(options.redirect, 'manual');
    calls.push({host: u.host, path, body});
    if (reply) {const value = await reply(u, body, calls); if (value) return Response.json(value[1], {status: value[0]});}
    if (path === '/admin/overview') return Response.json({region: u.host.includes('node-de') ? 'de' : 'us', node: {resources: {memory: {freeBytes: 8 * 1024 ** 3}, disk: {availableBytes: 50 * 1024 ** 3}}}, tenants: []});
    if (path === '/admin/ping') return Response.json({ok: true});
    if (path === '/v1/routing/instances') {tenantId = body.id; return Response.json(body);}
    if (path.endsWith('/hostname')) return Response.json({hostname: 'instance-1234.example.test'});
    if (path === '/control/provision') return Response.json({id: tenantId, status: 'ready'});
    return Response.json({error: 'not_found'}, {status: 404});
  };
  return {fetch, calls};
}
async function browser(worker, env, extra = {}) {
  let cookie = '', csrf = '';
  const call = (path, method = 'GET', body) => worker.fetch(new Request('https://dashboard.example.test' + path, {method, headers: {cookie, origin: 'https://dashboard.example.test', 'cf-connecting-ip': '198.51.100.20', 'content-type': 'application/json', 'x-csrf-token': csrf}, body: body === undefined ? undefined : JSON.stringify(body)}), env);
  const login = await call('/api/login', 'POST', {username: 'admin', password, ...extra});
  assert.equal(login.status, 200, await login.clone().text());
  cookie = login.headers.get('set-cookie').split(';')[0]; csrf = (await login.json()).csrf;
  return {call, cookie, csrf};
}

test('Worker login persists a hashed session in separate D1 across Worker instances and enforces CSRF', async () => {
  const {db, sqlite} = database(), env = environment(db), worker = createWorker();
  try {
    assert.equal((await worker.fetch(new Request('https://dashboard.example.test/api/overview'), env)).status, 401);
    const client = await browser(worker, env);
    assert.match(client.cookie, new RegExp('^' + COOKIE + '='));
    const fresh = createWorker();
    const result = await fresh.fetch(new Request('https://dashboard.example.test/api/session', {headers: {cookie: client.cookie}}), env);
    const session = await result.json(); assert.equal(session.authenticated, true);
    assert.equal(session.provisioning.databaseMode, 'us-central');
    const stored = sqlite.prepare('SELECT * FROM dashboard_sessions').get();
    assert.notEqual(stored.token_hash, client.cookie.split('=')[1]);
    assert.equal(stored.token_hash, await digest(client.cookie.split('=')[1]));
    const blocked = await fresh.fetch(new Request('https://dashboard.example.test/api/logout', {method: 'POST', headers: {cookie: client.cookie, 'content-type': 'application/json'}, body: '{}'}), env);
    assert.equal(blocked.status, 403);
    assert.equal((await client.call('/api/logout', 'POST', {})).status, 200);
    assert.equal((await client.call('/api/session')).status, 200);
    assert.equal((await (await client.call('/api/session')).json()).authenticated, false);
    assert.equal(JSON.stringify(session).includes(env.ADMIN_API_SECRET), false);
  } finally {sqlite.close();}
});

test('D1 login rate limits and TOTP replay checks work across isolates', async () => {
  const {db, sqlite} = database(), env = environment(db);
  try {
    env.DASHBOARD_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
    const code = totpCode(env.DASHBOARD_TOTP_SECRET, Math.floor(Date.now() / 30000));
    await browser(createWorker(), env, {code});
    const request = input => new Request('https://dashboard.example.test/api/login', {method: 'POST', headers: {'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.20'}, body: JSON.stringify(input)});
    const replay = await createWorker().fetch(request({username: 'admin', password, code}), env);
    assert.equal(replay.status, 401);
    for (let i = 0; i < 8; i++) await createWorker().fetch(request({username: 'admin', password: 'wrong password'}), env);
    assert.equal((await createWorker().fetch(request({username: 'admin', password}), env)).status, 429);
  } finally {sqlite.close();}
});

test('Worker deploy persists encrypted records, runs both nodes without initialAdmin, and survives restart', async () => {
  const {db, sqlite} = database(), env = environment(db), upstream = remote(env), worker = createWorker(upstream.fetch);
  try {
    const client = await browser(worker, env);
    assert.equal((await client.call('/api/instances', 'POST', {primary: 'de', licenseKey: license})).status, 409);
    const created = await client.call('/api/instances', 'POST', {primary: 'us', licenseKey: license});
    assert.equal(created.status, 201, await created.clone().text());
    const item = await created.json();
    const deployed = await client.call(`/api/instances/${item.id}/deploy`, 'POST', {});
    assert.equal(deployed.status, 202, await deployed.clone().text());
    assert.equal((await deployed.json()).adminCreation, 'signup');
    const encrypted = sqlite.prepare('SELECT record FROM dashboard_instances').get().record;
    assert.equal(encrypted.includes(license), false);
    const raw = await store(env).find(item.id);
    assert.ok(raw.appKey.startsWith('base64:'));
    for (let i = 0; i < 3; i++) {sqlite.exec('UPDATE dashboard_jobs SET next_at = 0'); await runJobs(env, upstream.fetch);}
    const done = await (await createWorker(upstream.fetch).fetch(new Request(`https://dashboard.example.test/api/instances/${item.id}`, {headers: {cookie: client.cookie}}), env)).json();
    assert.equal(done.status, 'ready', JSON.stringify(done));
    assert.equal(done.steps.routing, 'done');
    for (const call of upstream.calls.filter(x => x.path === '/control/provision')) assert.equal(Object.hasOwn(call.body, 'initialAdmin'), false);
    assert.equal(upstream.calls.filter(x => x.path === '/control/provision').length, 2);
    assert.equal(Object.hasOwn(done, 'appKey'), false); assert.equal(Object.hasOwn(done, 'fingerprint'), false);
    const job = sqlite.prepare('SELECT * FROM dashboard_jobs').get();
    assert.equal(job.status, 'done'); assert.deepEqual(await open(env.DASHBOARD_DATA_KEY, 'job:' + job.id, job.payload), {});
    assert.equal(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'routes'").get(), undefined);
  } finally {sqlite.close();}
});

test('persistent jobs retry transient node failures and retain optional credentials encrypted', async () => {
  const {db, sqlite} = database(), env = environment(db);
  let fail = true;
  const upstream = remote(env, {reply: async (u) => {if (u.pathname === '/control/provision' && fail) {fail = false; return [503, {error: 'operation_failed'}];}}});
  try {
    const client = await browser(createWorker(upstream.fetch), env);
    const item = await (await client.call('/api/instances', 'POST', {primary: 'us', licenseKey: license})).json();
    const admin = {displayName: 'Owner', email: 'owner@example.com', password: 'Strong-password-123!'};
    await client.call(`/api/instances/${item.id}/deploy`, 'POST', {initialAdmin: admin});
    assert.equal(sqlite.prepare('SELECT payload FROM dashboard_jobs').get().payload.includes(admin.password), false);
    await runJobs(env, upstream.fetch);
    assert.equal(sqlite.prepare('SELECT status FROM dashboard_jobs').get().status, 'running');
    for (let i = 0; i < 3; i++) {sqlite.exec('UPDATE dashboard_jobs SET next_at = 0'); await runJobs(env, upstream.fetch);}
    assert.equal((await store(env).find(item.id)).status, 'ready');
    const requests = upstream.calls.filter(x => x.path === '/control/provision');
    assert.deepEqual(requests.find(x => x.host.includes('node-us') && x.body.initialAdmin).body.initialAdmin, admin);
    assert.ok(requests.filter(x => x.host.includes('node-de')).every(x => !x.body.initialAdmin));
  } finally {sqlite.close();}
});

test('D1 encryption authenticates record identity and leases prevent concurrent job runners', async () => {
  const key = 'a'.repeat(64), sealed = await seal(key, 'instance:one', {appKey: 'secret'});
  await assert.rejects(open(key, 'instance:two', sealed));
  await assert.rejects(open('b'.repeat(64), 'instance:one', sealed));
  const {db, sqlite} = database(), env = environment(db);
  try {
    const first = store(env), second = store(env);
    const token = await first.lock('runner'); assert.ok(token);
    assert.equal(await second.lock('runner'), null);
    await second.unlock('runner', 'wrong'); assert.equal(await second.lock('runner'), null);
    await first.unlock('runner', token); assert.ok(await second.lock('runner'));
  } finally {sqlite.close();}
});

test('dashboard deployment refuses routing DB and verifies migrations before uploading', async () => {
  const config = readFileSync(new URL('../dashboard-worker/wrangler.toml', import.meta.url), 'utf8');
  assert.throws(() => bindDashboard(config, ROUTING_DATABASE), /separate/);
  const own = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const bound = bindDashboard(config, own);
  const {sqlite} = database();
  sqlite.exec("CREATE TABLE d1_migrations(name TEXT); INSERT INTO d1_migrations VALUES ('0001_dashboard.sql')");
  try {
    const results = verificationSql.split('; ').map(sql => ({success: true, results: sqlite.prepare(sql).all()}));
    verifySchema(results, ['0001_dashboard.sql']);
    const calls = [];
    await deployDashboard({config: bound, run: args => {calls.push(args); if (args[1] === 'execute') return JSON.stringify(results);}, build: async () => {}, log() {}});
    assert.deepEqual(calls.map(x => x[0] === 'deploy' ? 'deploy' : x[1]), ['migrations', 'execute', 'deploy']);
    assert.ok(calls.slice(0, 2).every(x => x.includes('DASHBOARD_DB') && !x.includes('DB')));
    const bad = structuredClone(results); bad[8].results[0].value = 'routing';
    assert.throws(() => verifySchema(bad, ['0001_dashboard.sql']), /identity/);
    await assert.rejects(deployDashboard({config: bindDashboard(config, own), run: args => args[1] === 'execute' ? JSON.stringify(bad) : '', build: async () => {throw Error('must not build');}, log() {}}), /identity/);
  } finally {sqlite.close();}
});

test('lifecycle jobs persist their plan and publish resume only after both nodes are ready', async () => {
  const {db, sqlite} = database(), env = environment(db), initial = remote(env);
  try {
    const client = await browser(createWorker(initial.fetch), env);
    const item = await (await client.call('/api/instances', 'POST', {primary: 'us', licenseKey: license})).json();
    await client.call(`/api/instances/${item.id}/deploy`, 'POST', {});
    for (let i = 0; i < 3; i++) {sqlite.exec('UPDATE dashboard_jobs SET next_at = 0'); await runJobs(env, initial.fetch);}
    const raw = await store(env).find(item.id);
    const nodeState = {us: 'ready', de: 'ready'};
    const versions = {us: 1, de: 1};
    const routed = {id: raw.id, serviceId: raw.serviceId, customerId: raw.customerId, primary: 'us', status: 'ready', lifecycleVersion: 1};
    const order = [];
    const upstream = remote(env, {reply: async (u, body) => {
      const region = u.host.includes('node-de') ? 'de' : 'us';
      const copy = {id: raw.id, fingerprint: raw.fingerprint, role: region === 'us' ? 'primary' : 'secondary', primary: 'us', status: nodeState[region], lifecycleVersion: versions[region]};
      if (u.pathname === '/admin/overview') return [200, {tenants: [copy]}];
      if (u.pathname === '/admin/tenant') return [200, copy];
      if (u.pathname === '/v1/routing/instances/' + item.id) return [200, {...routed}];
      if (u.pathname === '/v1/routing/instances') {order.push('router:' + body.status); Object.assign(routed, body); return [200, body];}
      if (u.pathname === '/control/lifecycle') {order.push(region + ':' + body.action); nodeState[region] = body.action; versions[region] = body.lifecycleVersion; return [200, body];}
      if (u.pathname === '/admin/resume') {order.push(region + ':resume'); nodeState[region] = 'ready'; versions[region] = body.lifecycleVersion; return [200, {status: 'ready'}];}
    }});
    const lifecycleClient = await browser(createWorker(upstream.fetch), env);
    for (const action of ['suspend', 'resume', 'terminate']) {
      const queued = await lifecycleClient.call(`/api/tenants/${item.id}/lifecycle`, 'POST', {action});
      assert.equal(queued.status, 202, await queued.clone().text());
      for (let i = 0; i < 4; i++) {sqlite.exec('UPDATE dashboard_jobs SET next_at = 0'); await runJobs(env, upstream.fetch);}
      const done = await store(env).find(item.id);
      assert.equal(done.status, {suspend: 'suspended', resume: 'ready', terminate: 'terminated'}[action], JSON.stringify(done));
      assert.equal(done.operation, null);
    }
    assert.deepEqual(order, ['router:suspended', 'us:suspended', 'de:suspended', 'us:resume', 'de:resume', 'router:ready', 'router:terminated', 'us:terminated', 'de:terminated']);
  } finally {sqlite.close();}
});

test('queued deployment cancellation is atomic and does not alter already-running jobs', async () => {
  const {db, sqlite} = database(), env = environment(db), upstream = remote(env);
  try {
    const client = await browser(createWorker(upstream.fetch), env);
    const item = await (await client.call('/api/instances', 'POST', {primary: 'us', licenseKey: license})).json();
    await client.call(`/api/instances/${item.id}/deploy`, 'POST', {});
    sqlite.exec("UPDATE dashboard_jobs SET status = 'running'");
    assert.equal((await client.call(`/api/instances/${item.id}/cancel`, 'POST', {})).status, 409);
    assert.equal((await store(env).find(item.id)).status, 'queued', 'failed cancellation did not update the instance');
    sqlite.exec("UPDATE dashboard_jobs SET status = 'queued'");
    assert.equal((await client.call(`/api/instances/${item.id}/cancel`, 'POST', {})).status, 200);
    assert.equal((await store(env).find(item.id)).status, 'ready_to_deploy');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dashboard_jobs').get().n, 0);
  } finally {sqlite.close();}
});

test('legacy instance import encrypts records and preserves application keys without overwriting IDs', async () => {
  const {importSql} = await import('../dashboard-worker/import.mjs');
  const {sqlite, db} = database(), env = environment(db);
  try {
    const id = 't-' + 'b'.repeat(24), appKey = 'base64:' + Buffer.alloc(32, 4).toString('base64');
    const source = JSON.stringify({instances: [{id, primary: 'us', secondary: 'de', hostname: 'old.example.test', appKey, fingerprint: 'f'.repeat(64), licenseKey: license, status: 'deploying', steps: {primary: 'running'}}]});
    const sql = await importSql(source, env.DASHBOARD_DATA_KEY);
    assert.equal(sql.includes(appKey), false); assert.equal(sql.includes(license), false);
    sqlite.exec(sql);
    const original = await store(env).find(id);
    assert.equal(original.appKey, appKey); assert.equal(original.status, 'failed'); assert.equal(original.error, 'dashboard_migrated');
    original.status = 'ready'; await store(env).save(original);
    sqlite.exec(await importSql(source, env.DASHBOARD_DATA_KEY));
    assert.equal((await store(env).find(id)).status, 'ready', 're-import did not overwrite existing state');
  } finally {sqlite.close();}
});

test('dashboard D1 setup creates or reuses only the separately named database', async () => {
  const {mkdtempSync, writeFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'dashboard-setup-'));
  const configFile = join(root, 'wrangler.toml');
  const config = readFileSync(new URL('../dashboard-worker/wrangler.toml', import.meta.url), 'utf8');
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  try {
    writeFileSync(configFile, config);
    const calls = [];
    assert.equal(setupDatabase({configFile, run: args => {calls.push(args); return args[1] === 'list' ? '[]' : `database_id = "${id}"`;}}), id);
    assert.deepEqual(calls, [['d1', 'list', '--json'], ['d1', 'create', 'spartan-cloud-dashboard']]);
    assert.equal(setupDatabase({configFile, run() {throw Error('must not create twice');}}), id);
    writeFileSync(configFile, config);
    assert.equal(setupDatabase({configFile, run: args => {assert.equal(args[1], 'list'); return JSON.stringify([{name: 'spartan-routing-load-dezerx-cloud', uuid: ROUTING_DATABASE}, {name: 'spartan-cloud-dashboard', uuid: id}]);}}), id);
    assert.throws(() => setupDatabase({configFile, databaseId: ROUTING_DATABASE}), /separate/);
  } finally {rmSync(root, {recursive: true, force: true});}
});
