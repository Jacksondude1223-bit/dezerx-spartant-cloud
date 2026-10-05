import test from 'node:test';
import assert from 'node:assert/strict';
import {signature, verify, digest, region} from '../workers/shared.js';
import provisioning, {Tenant} from '../workers/provisioning.js';
import routing from '../workers/routing.js';

const secret = 'a'.repeat(64);
async function signed(method, path, payload = '', stamp = String(Date.now())) {
  return new Request(`https://provision.example${path}`, {method, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, method, path, payload)}, body: method === 'GET' ? undefined : payload});
}
function fixture() {
  const tenants = new Map();
  const messages = [];
  const env = {BASE_DOMAIN: 'cloud.test', BILLING_WEBHOOK_SECRET: secret, NODE_CONTROL_SECRET: secret, ORIGIN_SECRET: secret, US_ORIGIN: 'https://us.origin.test', DE_ORIGIN: 'https://de.origin.test', PROVISION_QUEUE: {async send(value) { messages.push(value); }}};
  env.TENANTS = {getByName(id) {
    if (!tenants.has(id)) {
      const values = new Map();
      const storage = {async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm(value) { values.set('alarm', value); }, async deleteAlarm() { values.delete('alarm'); }, async transaction(fn) { return fn(storage); }};
      const tenant = new Tenant({storage, blockConcurrencyWhile: fn => fn()}, env);
      tenants.set(id, {tenant, values, async fetch(url, init) { return tenant.fetch(new Request(url, init)); }});
    }
    return tenants.get(id);
  }};
  return {env, tenants, messages};
}
async function reserve(env, changes = {}) {
  const body = JSON.stringify({serviceId: 'service_123', customerId: 'customer_123', primary: 'us', ...changes});
  return provisioning.fetch(await signed('POST', '/v1/instances', body), env);
}

test('signatures reject changed payloads, changed paths and expired timestamps', async () => {
  const req = await signed('POST', '/v1/instances', '{}');
  assert.equal(await verify(req, '{}', secret), true);
  assert.equal(await verify(req, '{"x":1}', secret), false);
  assert.equal(await verify(new Request('https://provision.example/other', req), '{}', secret), false);
  assert.equal(await verify(await signed('POST', '/v1/instances', '{}', String(Date.now() - 600000)), '{}', secret), false);
});
test('orders are idempotent and reject ownership or region changes', async () => {
  const {env, tenants} = fixture();
  const first = await reserve(env);
  assert.equal(first.status, 202);
  const record = await first.json();
  assert.equal(record.id, `t-${(await digest('service_123')).slice(0, 24)}`);
  assert.equal(tenants.size, 1);
  assert.equal((await reserve(env)).status, 202);
  assert.equal((await reserve(env, {customerId: 'attacker'})).status, 409);
  assert.equal((await reserve(env, {primary: 'de'})).status, 409);
  assert.equal((await reserve(env, {primary: 'xx'})).status, 400);
  assert.equal(record.appKey, undefined);
  assert.equal(record.customerId, undefined);
  assert.ok(tenants.get(record.id).values.get('alarm'));
});
test('unsigned requests cannot provision or read tenant state', async () => {
  const {env} = fixture();
  assert.equal((await provisioning.fetch(new Request('https://x/v1/instances', {method: 'POST', body: '{}'}), env)).status, 401);
});
test('alarms retain pending orders and queue provisioning', async () => {
  const {env, tenants, messages} = fixture();
  const record = await (await reserve(env)).json();
  await tenants.get(record.id).tenant.alarm();
  assert.deepEqual(messages, [{id: record.id}]);
  assert.ok(tenants.get(record.id).values.get('alarm'));
});
test('queue provisions primary before secondary and only then marks ready', async () => {
  const {env, tenants} = fixture();
  const record = await (await reserve(env, {primary: 'de'})).json();
  const previous = globalThis.fetch;
  const calls = [];
  let ack = false;
  globalThis.fetch = async (url, init) => {
    calls.push(new URL(url).host);
    assert.equal(await verify(new Request(url, init), init.body, secret), true);
    return Response.json({status: 'ready'});
  };
  try {
    await provisioning.queue({messages: [{body: {id: record.id}, ack() { ack = true; }, retry() { assert.fail('unexpected_retry'); }}]}, env);
    assert.deepEqual(calls, ['de.origin.test', 'us.origin.test']);
    assert.equal(ack, true);
    assert.equal(tenants.get(record.id).values.get('record').status, 'ready');
    assert.equal(tenants.get(record.id).values.has('alarm'), false);
  } finally { globalThis.fetch = previous; }
});
test('failed provisioning stays pending with retry and durable alarm', async () => {
  const {env, tenants} = fixture();
  const record = await (await reserve(env)).json();
  const previous = globalThis.fetch;
  let retried = false;
  globalThis.fetch = async () => new Response('', {status: 503});
  try {
    await provisioning.queue({messages: [{body: {id: record.id}, ack() { assert.fail('unexpected_ack'); }, retry() { retried = true; }}]}, env);
    assert.equal(retried, true);
    assert.equal(tenants.get(record.id).values.get('record').status, 'pending');
    assert.ok(tenants.get(record.id).values.get('alarm'));
  } finally { globalThis.fetch = previous; }
});
test('routing selects region, preserves application credentials, strips origin spoofing', async () => {
  const {env, tenants} = fixture();
  const record = await (await reserve(env)).json();
  await tenants.get(record.id).fetch('https://tenant/complete', {method: 'POST'});
  const request = new Request(`${record.url}/invoices?x=1`, {method: 'POST', body: 'invoice', headers: {authorization: 'Bearer app-token', cookie: 'session=value', 'x-spartan-origin': 'attacker', 'x-spartan-hop': '1', 'x-forwarded-host': 'evil.test'}});
  Object.defineProperty(request, 'cf', {value: {country: 'DE'}});
  const previous = globalThis.fetch;
  globalThis.fetch = async upstream => {
    assert.equal(new URL(upstream.url).host, 'de.origin.test');
    assert.equal(new URL(upstream.url).pathname, `/tenant/${record.id}/invoices`);
    assert.equal(new URL(upstream.url).search, '?x=1');
    assert.equal(await upstream.text(), 'invoice');
    assert.equal(upstream.headers.get('authorization'), 'Bearer app-token');
    assert.equal(upstream.headers.get('cookie'), 'session=value');
    assert.equal(upstream.headers.get('x-spartan-origin'), secret);
    assert.equal(upstream.headers.get('x-spartan-hop'), null);
    assert.equal(upstream.headers.get('x-forwarded-host'), null);
    return new Response('ok', {status: 201});
  };
  try { assert.equal((await routing.fetch(request, env)).status, 201); }
  finally { globalThis.fetch = previous; }
});
test('routing refuses unknown and pending tenants and never retries a failed write', async () => {
  const {env} = fixture();
  const record = await (await reserve(env)).json();
  assert.equal((await routing.fetch(new Request(record.url), env)).status, 503);
  assert.equal((await routing.fetch(new Request('https://evil.cloud.test'), env)).status, 404);
  await env.TENANTS.getByName(record.id).fetch('https://tenant/complete', {method: 'POST'});
  const previous = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('failed'); };
  try {
    const response = await routing.fetch(new Request(record.url, {method: 'POST', body: 'write'}), env);
    assert.equal(response.status, 503);
    assert.equal(attempts, 1);
  } finally { globalThis.fetch = previous; }
});
test('European countries use Germany and US defaults use US', () => {
  for (const country of ['DE', 'FR', 'GB', 'PL', 'NL', 'TR']) assert.equal(region(country), 'de');
  for (const country of ['US', 'CA', 'MX', 'AU', undefined]) assert.equal(region(country), 'us');
});
