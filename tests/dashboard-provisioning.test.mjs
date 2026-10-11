import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {createProvisioner, loadProvisioningConfig, normalizeDomain, productName} from '../dashboard/provisioning.mjs';
import {createDashboard, hashPassword} from '../dashboard/server.mjs';
import {verifyDomainPermit, issueDomainPermit} from '../node/domain-permit.mjs';

const adminSecret = 'a'.repeat(64);
const originSecret = 'o'.repeat(64);
const nodes = {us: 'http://127.0.0.1:8788', de: 'https://node-de.example.test'};
const license = 'SPARTANPROFESSIONAL_abcdefghijklmnop';
const admin = {displayName: 'Owner', email: 'owner@customer.test', password: 'a-good-password'};

async function setup({nodeReply, routerReply, nodeStatus} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spartan-dash-'));
  const provisioning = {...loadProvisioningConfig({ORIGIN_SECRET: originSecret, BASE_DOMAIN: 'load.example.test'}, adminSecret), stateFile: path.join(dir, 'instances.json')};
  const calls = [];
  const fetchImpl = async (url, init) => {
    const {origin, pathname} = new URL(url);
    const expected = createHmac('sha256', originSecret).update(`${init.headers['x-spartan-timestamp']}\nPOST\n${pathname}\n${init.body}`).digest('hex');
    assert.equal(init.headers['x-spartan-signature'], expected, `${pathname} is signed with ORIGIN_SECRET`);
    const body = JSON.parse(init.body);
    calls.push({origin, pathname, body});
    const [status, data] = origin === 'https://load.example.test' ? await (routerReply || defaultRouter)(pathname, body) : await (nodeReply || (() => [200, {id: body.id, status: 'ready'}]))(origin, body, calls);
    return new Response(JSON.stringify(data), {status});
  };
  const events = [];
  const provisioner = createProvisioner({provisioning}, {nodes, fetchImpl, nodeStatus, queueInterval: 3600000, sleep: async () => {}, record: (action, fields) => events.push({action, ...fields})});
  return {provisioner, calls, events, provisioning};
}
async function defaultRouter(pathname, body) {
  if (pathname === '/v1/routing/instances') return [201, {...body}];
  const assign = pathname.match(/^\/v1\/routing\/instances\/(t-[a-f0-9]{24})\/hostname$/);
  if (assign) return [200, {id: assign[1], hostname: 'instance-4321.example.test', url: 'https://instance-4321.example.test', status: 'active'}];
  if (pathname === '/v1/routing/onboarding/prepare') return [201, {hostname: body.hostname, status: 'pending_ownership', stage: 'spartan_ownership', readyToProvision: false, dnsRecords: [{type: 'CNAME', name: body.hostname, target: 'load.example.test', purpose: 'routing'}, {type: 'TXT', name: `_spartan-verification.${body.hostname}`, value: 'proof', purpose: 'spartan_ownership'}]}];
  if (pathname === '/v1/routing/onboarding/verify') {
    const permit = await issueDomainPermit(originSecret, body.id, body.hostname);
    return [200, {hostname: body.hostname, status: 'active', stage: 'ready_to_provision', readyToProvision: true, dnsRecords: [], domainVerificationToken: permit.token, tokenExpiresAt: new Date(permit.expiresAt).toISOString()}];
  }
  return [404, {error: 'not_found'}];
}

test('instance creation is optional and validates its configuration', () => {
  assert.equal(loadProvisioningConfig({}, adminSecret), null);
  assert.throws(() => loadProvisioningConfig({ORIGIN_SECRET: adminSecret, BASE_DOMAIN: 'load.example.test'}, adminSecret), /differ/);
  assert.throws(() => loadProvisioningConfig({ORIGIN_SECRET: 'short', BASE_DOMAIN: 'load.example.test'}, adminSecret), /32/);
  assert.throws(() => loadProvisioningConfig({ORIGIN_SECRET: originSecret}, adminSecret), /BASE_DOMAIN/);
  assert.equal(loadProvisioningConfig({ORIGIN_SECRET: originSecret, BASE_DOMAIN: 'Load.Example.Test'}, adminSecret).routingUrl, 'https://load.example.test');
  assert.equal(normalizeDomain('https://Panel.Customer.com/'), 'panel.customer.com');
  assert.equal(normalizeDomain('panel.customer.com:8443'), null);
  assert.equal(productName('SPARTANCLOUD_abcdefghijklmnop'), 'Cloud');
  assert.equal(productName('SPARTANCLOUDPLUS_abcdefghijklmnop'), 'Cloud Plus');
});

test('an assigned-hostname instance takes its licence at deploy, provisions both nodes, then publishes ready', async () => {
  const {provisioner, calls, provisioning} = await setup();
  await assert.rejects(provisioner.create({primary: 'us', licenseKey: 'NOTSPARTAN_abcdefghijkl'}, 'admin'), /invalid_license_key/);
  const created = await provisioner.create({primary: 'de'}, 'admin');
  assert.equal(created.status, 'ready_to_deploy');
  assert.equal(created.hostname, 'instance-4321.example.test', 'the routing Worker assigns a one-level hostname');
  assert.equal(created.licenseHint, null);
  assert.deepEqual(calls.splice(0).map(c => [c.pathname, c.body.status]), [['/v1/routing/instances', 'pending'], [`/v1/routing/instances/${created.id}/hostname`, undefined]]);
  for (const secret of ['appKey', 'fingerprint', 'licenseKey']) assert.equal(created[secret], undefined, `${secret} never reaches the browser`);
  assert.ok(!JSON.stringify(created).includes(license));

  await assert.rejects(provisioner.deploy(created.id, {initialAdmin: {...admin, role: 'owner'}}, 'admin'), /invalid_initial_admin/);
  await assert.rejects(provisioner.deploy(created.id, {initialAdmin: admin}, 'admin'), /license_key_required/);
  await provisioner.deploy(created.id, {licenseKey: license, initialAdmin: admin}, 'admin');
  await provisioner.idle();
  const done = await provisioner.get(created.id);
  assert.equal(done.product, 'Professional');
  for (const secret of ['appKey', 'fingerprint', 'licenseKey']) assert.equal(done[secret], undefined);
  assert.ok(!JSON.stringify(done).includes(license));
  assert.equal(done.status, 'ready');
  assert.deepEqual(calls.map(c => `${c.origin}${c.pathname}`), ['https://node-de.example.test/control/provision', 'http://127.0.0.1:8788/control/provision', 'https://load.example.test/v1/routing/instances']);
  const [primary, secondary, route] = calls.map(c => c.body);
  assert.deepEqual(primary.initialAdmin, admin);
  assert.equal(secondary.initialAdmin, undefined, 'the administrator is created on the primary only');
  for (const key of ['id', 'primary', 'appKey', 'fingerprint', 'licenseKey', 'url', 'lifecycleVersion']) assert.deepEqual(secondary[key], primary[key]);
  assert.match(primary.appKey, /^base64:[A-Za-z0-9+/]{43}=$/);
  assert.match(primary.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await verifyDomainPermit(primary.domainVerificationToken, originSecret, created.id, created.hostname), true);
  assert.deepEqual(route, {id: created.id, serviceId: done.serviceId, customerId: 'dashboard', primary: 'de', status: 'ready', lifecycleVersion: 1});

  const saved = await readFile(provisioning.stateFile, 'utf8');
  assert.equal((await stat(provisioning.stateFile)).mode & 0o777, 0o600);
  assert.ok(!saved.includes(admin.password), 'the administrator password is never written to disk');
  await assert.rejects(provisioner.discard(created.id, 'admin'), /instance_deployed/);
});

test('a customer domain waits for verification and deploys with the routing Worker permit', async () => {
  let verified = false;
  const {provisioner, calls} = await setup({routerReply: async (pathname, body) => {
    if (pathname === '/v1/routing/onboarding/verify' && !verified) return [409, {hostname: body.hostname, error: 'ownership_not_verified', status: 'pending_ownership', stage: 'spartan_ownership', readyToProvision: false, dnsRecords: []}];
    return defaultRouter(pathname, body);
  }});
  await assert.rejects(provisioner.create({primary: 'us', licenseKey: license, domain: 'node-de.example.test'}, 'admin'), /reserved_hostname/);
  await assert.rejects(provisioner.create({primary: 'us', licenseKey: license, domain: 'x.load.example.test'}, 'admin'), /reserved_hostname/);
  const created = await provisioner.create({primary: 'us', licenseKey: license, domain: 'https://Panel.Customer.test/', customerId: 'cus_42'}, 'admin');
  assert.equal(created.status, 'awaiting_dns');
  assert.equal(created.hostname, 'panel.customer.test');
  assert.equal(created.dns.records.length, 2);
  assert.deepEqual(calls[0].body, {id: created.id, serviceId: created.serviceId, customerId: 'cus_42', primary: 'us', hostname: 'panel.customer.test'});
  await assert.rejects(provisioner.deploy(created.id, {initialAdmin: admin}, 'admin'), /domain_not_verified/);
  assert.equal((await provisioner.verify(created.id)).status, 'awaiting_dns');
  verified = true;
  const ready = await provisioner.verify(created.id);
  assert.equal(ready.status, 'ready_to_deploy');
  assert.equal(ready.dns.domainVerificationToken, undefined, 'the permit stays on the server');
  await provisioner.deploy(created.id, {initialAdmin: admin}, 'admin');
  await provisioner.idle();
  assert.equal((await provisioner.get(created.id)).status, 'ready');
  const provisions = calls.filter(c => c.pathname === '/control/provision');
  assert.equal(provisions.length, 2);
  for (const call of provisions) {
    assert.equal(call.body.url, 'https://panel.customer.test');
    assert.equal(await verifyDomainPermit(call.body.domainVerificationToken, originSecret, created.id, 'panel.customer.test'), true);
  }
});

test('a deployment retries a node that is still provisioning and reports failures', async () => {
  let attempts = 0;
  const {provisioner} = await setup({nodeReply: (origin, body) => {
    if (origin.startsWith('http://127.0.0.1')) { attempts++; return attempts < 3 ? [200, {id: body.id, status: 'provisioning'}] : [200, {id: body.id, status: 'ready'}]; }
    return [409, {error: 'tenant_conflict'}];
  }});
  const created = await provisioner.create({primary: 'us', licenseKey: license}, 'admin');
  await provisioner.deploy(created.id, {initialAdmin: admin}, 'admin');
  await provisioner.idle();
  const failed = await provisioner.get(created.id);
  assert.equal(attempts, 3);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'tenant_conflict');
  assert.deepEqual(failed.steps, {primary: 'done', secondary: 'failed'});
  const story = failed.log.map(entry => entry.text).join('\n');
  assert.match(story, /container is running but the app is not answering yet/);
  assert.match(story, /Asking node-us again \(attempt 3\)/);
  assert.match(story, /node-us is ready after/);
  assert.match(story, /node-de answered tenant_conflict\. Stopping\./);
  assert.equal(failed.progress, null);
});

test('the dashboard exposes instance creation only when configured, behind session and CSRF', async () => {
  const {provisioning} = await setup();
  const config = {secret: adminSecret, nodes, provisioning, user: 'admin', passwordHash: await hashPassword('a long admin password'), secureCookie: false, sessionHours: 1, publicLabel: 'Spartan Cloud'};
  const server = createDashboard(config, {log: () => {}, fetchImpl: async (url, init) => { const [status, data] = await defaultRouter(new URL(url).pathname, JSON.parse(init.body)); return new Response(JSON.stringify(data), {status}); }});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/instances`)).status, 401);
    const login = await fetch(`${origin}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'admin', password: 'a long admin password'})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const {csrf} = await login.json();
    const session = await (await fetch(`${origin}/api/session`, {headers: {cookie}})).json();
    assert.deepEqual(session.provisioning, {baseDomain: 'load.example.test', instanceDomain: 'example.test'});
    const body = JSON.stringify({primary: 'us', licenseKey: license});
    assert.equal((await fetch(`${origin}/api/instances`, {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body})).status, 403);
    const created = await fetch(`${origin}/api/instances`, {method: 'POST', headers: {cookie, 'content-type': 'application/json', 'x-csrf-token': csrf}, body});
    assert.equal(created.status, 201);
    const item = await created.json();
    assert.equal((await (await fetch(`${origin}/api/instances`, {headers: {cookie}})).json()).instances[0].id, item.id);
    assert.equal((await fetch(`${origin}/api/instances/${item.id}/discard`, {method: 'POST', headers: {cookie, 'content-type': 'application/json', 'x-csrf-token': csrf}, body: '{}'})).status, 200);
  } finally { server.close(); }

  const plain = createDashboard({...config, provisioning: null}, {log: () => {}});
  await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${plain.address().port}`;
    const login = await fetch(`${base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'admin', password: 'a long admin password'})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(`${base}/api/session`, {headers: {cookie}})).json()).provisioning, null);
    const response = await fetch(`${base}/api/instances`, {headers: {cookie}});
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'provisioning_disabled');
  } finally { plain.close(); }
});

test('a custom-domain deploy renews an expiring permit between attempts instead of failing as busy', async () => {
  let nodeCalls = 0;
  const {provisioner, calls} = await setup({
    routerReply: async (pathname, body) => {
      if (pathname !== '/v1/routing/onboarding/verify') return defaultRouter(pathname, body);
      const permit = await issueDomainPermit(originSecret, body.id, body.hostname);
      // Close to expiry, so every attempt has to fetch a fresh one.
      return [200, {hostname: body.hostname, status: 'active', stage: 'ready_to_provision', readyToProvision: true, dnsRecords: [], domainVerificationToken: permit.token, tokenExpiresAt: new Date(Date.now() + 60000).toISOString()}];
    },
    nodeReply: (origin, body) => { nodeCalls++; return [200, {id: body.id, status: nodeCalls < 3 ? 'provisioning' : 'ready'}]; }
  });
  const created = await provisioner.create({primary: 'us', licenseKey: license, domain: 'panel.customer.test'}, 'admin');
  await provisioner.verify(created.id);
  await provisioner.deploy(created.id, {initialAdmin: admin}, 'admin');
  await provisioner.idle();
  const done = await provisioner.get(created.id);
  assert.equal(done.status, 'ready', done.error);
  assert.ok(calls.filter(c => c.pathname === '/v1/routing/onboarding/verify').length >= 3, 'the permit was renewed during the deploy');
});

test('a failed deploy never leaves a step marked running and says why', async () => {
  let checks = 0;
  const {provisioner} = await setup({
    routerReply: async (pathname, body) => {
      if (pathname !== '/v1/routing/onboarding/verify') return defaultRouter(pathname, body);
      if (++checks > 1) return [409, {error: 'service_not_active'}];
      const permit = await issueDomainPermit(originSecret, body.id, body.hostname);
      return [200, {hostname: body.hostname, status: 'active', stage: 'ready_to_provision', readyToProvision: true, dnsRecords: [], domainVerificationToken: permit.token, tokenExpiresAt: new Date(Date.now() + 60000).toISOString()}];
    }
  });
  const created = await provisioner.create({primary: 'us', licenseKey: license, domain: 'panel.customer.test'}, 'admin');
  await provisioner.verify(created.id);
  await provisioner.deploy(created.id, {initialAdmin: admin}, 'admin');
  await provisioner.idle();
  const failed = await provisioner.get(created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps.primary, 'failed');
  assert.match(failed.log.map(entry => entry.text).join('\n'), /Renewing the domain permit with the routing Worker failed: service_not_active/);
});

const GiB = 1024 ** 3;
const room = (memory, disk = 50) => ({node: {resources: {memory: {freeBytes: memory * GiB}, disk: {availableBytes: disk * GiB}}}});

test('a deployment waits in the queue until both nodes have room, then starts by itself', async () => {
  const free = {us: 0.4, de: 8};
  const {provisioner, calls} = await setup({nodeStatus: async region => room(free[region])});
  const created = await provisioner.create({primary: 'de', licenseKey: license}, 'admin');
  const queued = await provisioner.deploy(created.id, {initialAdmin: admin}, 'admin');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queue.position, 1);
  assert.match(queued.queue.reason, /node-us has 0\.4 GB memory free; needs 1\.0 GB/);
  assert.equal(calls.filter(c => c.pathname === '/control/provision').length, 0, 'nothing is provisioned while a node is short of room');
  await assert.rejects(provisioner.deploy(created.id, {initialAdmin: admin}, 'admin'), /instance_busy/);
  free.us = 4;
  await provisioner.pump();
  await provisioner.idle();
  const done = await provisioner.get(created.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.queue, null);
  assert.match(done.log.map(entry => entry.text).join('\n'), /Queued: node-us has 0\.4 GB memory free/);
});

test('one deployment per node at a time; the next one starts when it finishes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  const {provisioner} = await setup({nodeStatus: async () => room(8), nodeReply: async (origin, body) => { if (first) { first = false; await gate; } return [200, {id: body.id, status: 'ready'}]; }});
  const a = await provisioner.create({primary: 'us', licenseKey: license}, 'admin');
  const b = await provisioner.create({primary: 'de', licenseKey: license}, 'admin');
  assert.equal((await provisioner.deploy(a.id, {initialAdmin: admin}, 'admin')).status, 'deploying');
  const waiting = await provisioner.deploy(b.id, {initialAdmin: admin}, 'admin');
  assert.equal(waiting.status, 'queued');
  assert.match(waiting.queue.reason, /waiting for another deployment on node-/);
  release();
  await provisioner.idle();
  assert.equal((await provisioner.get(a.id)).status, 'ready');
  assert.equal((await provisioner.get(b.id)).status, 'ready', 'the queued deployment started once the first finished');
});

test('a queued deployment can be cancelled', async () => {
  const {provisioner} = await setup({nodeStatus: async () => room(0.1)});
  const created = await provisioner.create({primary: 'us', licenseKey: license}, 'admin');
  await provisioner.deploy(created.id, {initialAdmin: admin}, 'admin');
  const cancelled = await provisioner.cancel(created.id, 'admin');
  assert.equal(cancelled.status, 'ready_to_deploy');
  assert.equal(cancelled.queue, null);
  await assert.rejects(provisioner.cancel(created.id, 'admin'), /not_queued/);
});
