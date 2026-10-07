import test from 'node:test';
import assert from 'node:assert/strict';
import routing, {RoutingTenant, Domains} from '../workers/routing.js';
import {signature} from '../workers/shared.js';
import {d1} from './d1.mjs';
import {resolveHostname} from '../workers/store.js';
const secret = 'r'.repeat(64);
const id = 't-' + 'a'.repeat(24);
const input = {id, serviceId: 'service_1', customerId: 'customer_1', primary: 'us', status: 'ready', lifecycleVersion: 0};
function fixture() {
  const records = new Map();
  const env = {BASE_DOMAIN: 'cloud.test', US_ORIGIN: 'https://us.origin.test', DE_ORIGIN: 'https://de.origin.test', ROUTING_CONTROL_SECRET: secret, ORIGIN_SECRET: 'origin', SAAS_ZONE_DOMAIN: 'provider.test', SAAS_CNAME_TARGET: 'cloud.test'};
  const namespace = Class => ({getByName(name) {
    const key = `${Class.name}:${name}`;
    if (!records.has(key)) records.set(key, new Map());
    const values = records.get(key);
    const storage = {async get(k) { return structuredClone(values.get(k)); }, async put(k, v) { values.set(k, structuredClone(v)); }, async list({prefix}) { return new Map([...values].filter(([k]) => k.startsWith(prefix))); }, async setAlarm() {}, async deleteAlarm() {}};
    const object = new Class({storage, blockConcurrencyWhile: fn => fn()}, env);
    return {fetch: (url, init) => object.fetch(new Request(url, init))};
  }});
  env.DB = d1();
  env.TENANTS = namespace(RoutingTenant);
  env.DOMAINS = namespace(Domains);
  return {env, records};
}
async function signed(path, payload, signingSecret = secret) {
  const method = payload === undefined ? 'GET' : 'POST';
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const stamp = String(Date.now());
  return new Request(`https://routing.workers.dev${path}`, {method, body: method === 'POST' ? body : undefined, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(signingSecret, stamp, method, path, body)}});
}
async function register(env, changes = {}) { return routing.fetch(await signed('/v1/routing/instances', {...input, ...changes}), env); }
function customer(path = '/') { return new Request(`https://${id}.cloud.test${path}`, {headers: {'cf-connecting-ip': '198.51.100.5'}}); }

test('standalone registry rejects unsigned or wrong-secret updates and invalid metadata', async () => {
  const {env, records} = fixture();
  assert.equal((await routing.fetch(new Request('https://routing.workers.dev/v1/routing/instances', {method: 'POST', body: JSON.stringify(input)}), env)).status, 401);
  assert.equal((await routing.fetch(await signed('/v1/routing/instances', input, 'wrong'), env)).status, 401);
  assert.equal(records.size, 0);
  assert.equal((await register(env, {customerId: ['customer_1']})).status, 400);
  assert.equal((await register(env, {lifecycleVersion: -1})).status, 400);
});
test('registered instances persist locally and route without another Worker', async t => {
  const {env} = fixture();
  assert.equal((await register(env)).status, 201);
  assert.equal((await register(env)).status, 200);
  const status = await routing.fetch(await signed(`/v1/routing/instances/${id}`), env);
  assert.deepEqual(await status.json(), input);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let target;
  globalThis.fetch = async request => { target = request; return new Response('tenant-panel'); };
  assert.equal(await (await routing.fetch(customer('/billing'), env)).text(), 'tenant-panel');
  assert.equal(target.url, `https://us.origin.test/tenant/${id}/billing`);
  assert.equal(target.headers.get('x-spartan-client-ip'), '198.51.100.5');
  assert.equal(target.headers.get('x-spartan-origin'), 'origin');
});
test('versioned lifecycle blocks stale resumes and preserves termination tombstones', async () => {
  const {env} = fixture();
  await register(env);
  assert.equal((await register(env, {status: 'suspended', lifecycleVersion: 1})).status, 200);
  assert.equal((await routing.fetch(customer(), env)).status, 403);
  assert.equal((await register(env)).status, 409);
  assert.equal((await register(env, {customerId: 'other', lifecycleVersion: 2})).status, 409);
  assert.equal((await register(env, {status: 'active', lifecycleVersion: 2})).status, 200);
  assert.equal((await register(env, {status: 'terminated', lifecycleVersion: 3})).status, 200);
  assert.equal((await routing.fetch(customer(), env)).status, 410);
  assert.equal((await register(env, {status: 'ready', lifecycleVersion: 4})).status, 409);
});
test('managed domains are reserved locally and cannot be reassigned to another service', async () => {
  const {env} = fixture();
  await register(env);
  const path = `/v1/routing/instances/${id}/domains/reserve`;
  const response = await routing.fetch(await signed(path, {hostname: 'billing.customer.test'}), env);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).tenantId, id);
  const second = 't-' + 'b'.repeat(24);
  await register(env, {id: second, serviceId: 'service_2', customerId: 'customer_2'});
  const conflict = await routing.fetch(await signed(`/v1/routing/instances/${second}/domains/reserve`, {hostname: 'billing.customer.test'}), env);
  assert.equal(conflict.status, 409);
});
test('customer API paths are forwarded to the panel and cannot modify routing records', async t => {
  const {env} = fixture();
  await register(env);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('customer-app');
  assert.equal(await (await routing.fetch(customer('/v1/routing/instances'), env)).text(), 'customer-app');
  assert.deepEqual(await (await routing.fetch(await signed(`/v1/routing/instances/${id}`), env)).json(), input);
});
test('oversized routing control payloads are refused before registration', async () => {
  const {env, records} = fixture();
  const request = new Request('https://routing.workers.dev/v1/routing/instances', {method: 'POST', body: 'x'.repeat(65537)});
  assert.equal((await routing.fetch(request, env)).status, 413);
  assert.equal(records.size, 0);
});

test('custom domain registrations migrate out of the Durable Object into D1', async () => {
  const {env, records} = fixture();
  // Seed the legacy object exactly as a pre-D1 deployment would have left it.
  records.set('Domains:registry', new Map([
    ['domain:billing.customer.test', {hostname: 'billing.customer.test', tenantId: id, token: 'token-1', status: 'active', cloudflareId: 'cf-1', slotReserved: true, createAttempted: true, nextCheckAt: 1234}],
    ['domain:shop.customer.test', {hostname: 'shop.customer.test', tenantId: id, token: 'token-2', status: 'pending_ownership', nextCheckAt: 99}],
    ['budgetUsed', 7]
  ]));
  assert.equal(await resolveHostname(env, 'billing.customer.test'), null);
  const migrated = await routing.fetch(await signed('/v1/routing/migrate/domains', {}), env);
  assert.equal(migrated.status, 200);
  assert.deepEqual(await migrated.json(), {found: 2, imported: 2}, 'the stray budgetUsed key is not a domain');
  assert.equal(await resolveHostname(env, 'billing.customer.test'), id);
  assert.equal(await resolveHostname(env, 'shop.customer.test'), null, 'a pending reservation must not route yet');
  const again = await routing.fetch(await signed('/v1/routing/migrate/domains', {}), env);
  assert.deepEqual(await again.json(), {found: 2, imported: 0}, 'replaying the migration changes nothing');
  assert.equal((await routing.fetch(new Request('https://routing.workers.dev/v1/routing/migrate/domains', {method: 'POST', body: '{}'}), env)).status, 401, 'migration requires a signature');
});
