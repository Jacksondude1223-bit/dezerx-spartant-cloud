import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {createDashboard, hashPassword, verifyPassword, loadConfig, base32Encode, base32Decode, totpCode, checkTotp} from '../dashboard/server.mjs';

const secret = 's'.repeat(64);
const id = 't-' + 'c'.repeat(24);

test('dashboard passwords are scrypt hashed and verified', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('wrong horse battery', stored), false);
  assert.equal(await verifyPassword('x', 'plain-text'), false);
  await assert.rejects(hashPassword('short'), /12 to 1024/);
});

test('dashboard configuration requires the admin secret, a login and https node origins', () => {
  const base = {ADMIN_API_SECRET: secret, DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD_HASH: 'scrypt$1$1$1$a$b', US_ORIGIN: 'https://node-us.example.test/'};
  assert.equal(loadConfig(base).nodes.us, 'https://node-us.example.test');
  assert.throws(() => loadConfig({...base, ADMIN_API_SECRET: 'short'}), /ADMIN_API_SECRET/);
  assert.throws(() => loadConfig({...base, DASHBOARD_PASSWORD_HASH: 'hunter2'}), /DASHBOARD_PASSWORD_HASH/);
  assert.throws(() => loadConfig({...base, US_ORIGIN: 'http://node-us.example.test'}), /https/);
  assert.equal(loadConfig({...base, US_ORIGIN: 'http://127.0.0.1:8788'}).nodes.us, 'http://127.0.0.1:8788');
  assert.throws(() => loadConfig({...base, US_ORIGIN: undefined}), /US_ORIGIN/);
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('dashboard signs node calls, enforces sessions and CSRF, and streams downloads', async () => {
  const calls = [];
  const node = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const expected = createHmac('sha256', secret).update(`${req.headers['x-spartan-timestamp']}\nPOST\n${req.url}\n${body}`).digest('hex');
    if (req.headers['x-spartan-signature'] !== expected) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const input = JSON.parse(body);
    calls.push({path: req.url, input});
    const json = (status, value) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(value)); };
    if (req.url === '/admin/ping') return json(200, {ok: true, region: 'us'});
    if (req.url === '/admin/overview') return json(200, {region: 'us', host: 'node-us.example.test', node: {status: 'ready'}, tenants: [{id, status: 'ready'}]});
    if (req.url === '/admin/exec') return json(200, {id, exitCode: 0, stdout: 'hello\n', stderr: '', cwd: '/var/www/html'});
    if (req.url === '/admin/fs') return json(403, {error: 'permission_denied'});
    if (req.url === '/admin/resources') return json(200, {id, cpuLimit: String(input.cpuLimit ?? '2.5'), cpuLimitSource: input.cpuLimit === null ? 'node' : 'tenant', nodeCpuDefault: '2.5', applied: true});
    if (req.url === '/admin/fs/download') { res.writeHead(200, {'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="app.php"', 'content-length': '5'}); res.end('<?php'); return; }
    json(404, {error: 'not_found'});
  });
  const nodeOrigin = await listen(node);
  const logged = [];
  const dashboard = createDashboard({secret, nodes: {us: nodeOrigin}, user: 'admin', passwordHash: await hashPassword('a long admin password'), secureCookie: false, sessionHours: 1, publicLabel: 'Spartan Cloud'}, {log: value => logged.push(value)});
  const origin = await listen(dashboard);
  try {
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${origin}/demo.js`)).status, 404, 'the demo data layer is never served');
    assert.equal((await fetch(`${origin}/api/overview`)).status, 401);
    assert.deepEqual(await (await fetch(`${origin}/api/session`)).json(), {authenticated: false, label: 'Spartan Cloud', twoFactor: false});
    const post = (path, body, headers = {}) => fetch(origin + path, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
    assert.equal((await post('/api/login', {username: 'admin', password: 'wrong password!!'})).status, 401);
    const login = await post('/api/login', {username: 'admin', password: 'a long admin password'});
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    const {csrf} = await login.json();
    const session = await (await fetch(`${origin}/api/session`, {headers: {cookie}})).json();
    assert.equal(session.authenticated, true);
    assert.deepEqual(session.nodes.map(n => n.region), ['us']);
    const overview = await (await fetch(`${origin}/api/overview`, {headers: {cookie}})).json();
    assert.equal(overview.nodes[0].ok, true);
    assert.equal(overview.nodes[0].tenants[0].id, id);
    assert.equal(overview.nodes[0].host, 'node-us.example.test', 'the node\'s public name replaces the loopback address');
    assert.ok(Number.isInteger(overview.nodes[0].latencyMs), 'latency comes from the ping route');
    assert.equal((await post(`/api/nodes/us/tenants/${id}/exec`, {command: 'echo hello'}, {cookie})).status, 403, 'CSRF token required');
    const exec = await post(`/api/nodes/us/tenants/${id}/exec`, {command: 'echo hello', user: 'www-data'}, {cookie, 'x-csrf-token': csrf});
    assert.equal(exec.status, 200);
    assert.equal((await exec.json()).stdout, 'hello\n');
    assert.deepEqual(calls.find(call => call.path === '/admin/exec').input, {id, command: 'echo hello', user: 'www-data'});
    const cpu = await post(`/api/nodes/us/tenants/${id}/resources`, {cpuLimit: '3.5'}, {cookie, 'x-csrf-token': csrf});
    assert.equal(cpu.status, 200);
    assert.equal((await cpu.json()).cpuLimit, '3.5');
    assert.deepEqual(calls.find(call => call.path === '/admin/resources').input, {id, cpuLimit: '3.5'}, 'the CPU limit is forwarded, signed, to the node');
    assert.equal((await post(`/api/nodes/us/tenants/${id}/resources`, {}, {cookie, 'x-csrf-token': csrf})).status, 422, 'a missing limit is refused');
    assert.equal((await post(`/api/nodes/us/tenants/${id}/resources`, {cpuLimit: '2'}, {cookie})).status, 403, 'CSRF token required');
    const denied = await post(`/api/nodes/us/tenants/${id}/fs`, {action: 'delete', path: '/etc/passwd'}, {cookie, 'x-csrf-token': csrf});
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'permission_denied');
    const file = await fetch(`${origin}/api/nodes/us/tenants/${id}/fs/download?path=${encodeURIComponent('/var/www/html/app.php')}`, {headers: {cookie}});
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /app\.php/);
    assert.equal(await file.text(), '<?php');
    assert.equal((await post(`/api/nodes/de/tenants/${id}/exec`, {command: 'id'}, {cookie, 'x-csrf-token': csrf})).status, 404, 'unconfigured node');
    assert.equal((await post('/api/nodes/us/tenants/not-a-tenant/exec', {command: 'id'}, {cookie, 'x-csrf-token': csrf})).status, 404);
    const activity = await (await fetch(`${origin}/api/activity`, {headers: {cookie}})).json();
    assert.ok(activity.events.some(e => e.action === 'exec' && e.command === 'echo hello'));
    assert.ok(activity.events.some(e => e.action === 'cpu_limit' && e.cpuLimit === '3.5'), 'CPU limit changes are audited');
    assert.ok(logged.some(e => e.event === 'login_failed'));
    assert.equal(JSON.stringify(logged).includes('a long admin password'), false, 'passwords are never logged');
    assert.equal((await post('/api/logout', {}, {cookie, 'x-csrf-token': csrf})).status, 200);
    assert.equal((await fetch(`${origin}/api/overview`, {headers: {cookie}})).status, 401);
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await post('/api/login', {username: 'admin', password: 'wrong password!!'})).status === 429) limited++;
    assert.ok(limited >= 1, 'repeated failures are rate limited');
  } finally { dashboard.close(); node.close(); }
});

test('dashboard reports an unreachable node without failing the whole overview', async () => {
  const dashboard = createDashboard({secret, nodes: {us: 'http://127.0.0.1:9'}, user: 'admin', passwordHash: await hashPassword('a long admin password'), secureCookie: false, sessionHours: 1, publicLabel: 'X'}, {log: () => {}});
  const origin = await listen(dashboard);
  try {
    const login = await fetch(`${origin}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'admin', password: 'a long admin password'})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const overview = await (await fetch(`${origin}/api/overview`, {headers: {cookie}})).json();
    assert.equal(overview.nodes[0].ok, false);
    assert.equal(overview.nodes[0].error, 'node_unreachable');
  } finally { dashboard.close(); }
});

test('authenticator codes match the RFC 6238 test vectors and are single use', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpCode(secret, Math.floor(1234567890 / 30)), '005924');
  const at = 1234567890 * 1000;
  const counter = checkTotp(secret, '005924', at);
  assert.equal(counter, Math.floor(1234567890 / 30));
  assert.equal(checkTotp(secret, '005924', at, counter), null, 'a used code is refused');
  assert.equal(checkTotp(secret, '005924', at + 90000), null, 'codes expire after the next step');
  assert.equal(checkTotp(secret, '12345', at), null);
});

test('dashboard under /panel requires an authenticator code and scopes its cookie', async () => {
  const secret = base32Encode(Buffer.from('abcdefghijabcdefghij'));
  let clock = 1_800_000_000_000;
  const dashboard = createDashboard({secret: 's'.repeat(64), nodes: {us: 'http://127.0.0.1:9'}, user: 'admin', passwordHash: await hashPassword('a long admin password'), secureCookie: true, sessionHours: 1, publicLabel: 'X', basePath: '/panel', totpSecret: secret}, {log: () => {}, now: () => clock});
  const origin = await listen(dashboard);
  try {
    const bare = await fetch(`${origin}/panel`, {redirect: 'manual'});
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.get('location'), '/panel/');
    assert.equal((await fetch(`${origin}/panel/`)).status, 200);
    assert.equal((await fetch(`${origin}/panel/app.js`)).status, 200);
    assert.equal((await fetch(`${origin}/api/session`)).status, 404, 'nothing is served outside the prefix');
    assert.equal((await (await fetch(`${origin}/panel/api/session`)).json()).twoFactor, true);
    const login = body => fetch(`${origin}/panel/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    const credentials = {username: 'admin', password: 'a long admin password'};
    assert.equal((await login(credentials)).status, 401, 'password alone is not enough');
    assert.equal((await login({...credentials, code: '000000'})).status, 401);
    const code = totpCode(secret, Math.floor(clock / 30000));
    const ok = await login({...credentials, code});
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /Path=\/panel; HttpOnly; SameSite=Strict; Max-Age=3600; Secure/);
    assert.equal((await login({...credentials, code})).status, 401, 'the same code cannot be replayed');
    clock += 30000;
    assert.equal((await login({...credentials, code: totpCode(secret, Math.floor(clock / 30000))})).status, 200);
  } finally { dashboard.close(); }
});

test('dashboard configuration validates the base path and authenticator secret', () => {
  const base = {ADMIN_API_SECRET: secret, DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD_HASH: 'scrypt$1$1$1$a$b', US_ORIGIN: 'https://node-us.example.test'};
  assert.equal(loadConfig({...base, DASHBOARD_BASE_PATH: '/panel'}).basePath, '/panel');
  assert.throws(() => loadConfig({...base, DASHBOARD_BASE_PATH: '/../x'}), /BASE_PATH/);
  assert.throws(() => loadConfig({...base, DASHBOARD_TOTP_SECRET: 'short'}), /TOTP/);
  assert.equal(loadConfig({...base, DASHBOARD_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'}).totpSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});
