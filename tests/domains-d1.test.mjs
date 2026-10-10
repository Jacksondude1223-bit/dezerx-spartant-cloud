import test from 'node:test';
import assert from 'node:assert/strict';
import {domainAction, monitorDomains} from '../workers/domains-d1.js';
import {countCloudflareSlots, countDomains, readDomain} from '../workers/store.js';
import {d1, setRoute, readDomainRow} from './d1.mjs';

const first = `t-${'a'.repeat(24)}`;
const second = `t-${'b'.repeat(24)}`;
const host = 'billing.customer.test';

function fixture({ready = [first, second]} = {}) {
  const env = {BASE_DOMAIN: 'cloud.provider.test', SAAS_ZONE_DOMAIN: 'provider.test', SAAS_CNAME_TARGET: 'cloud.provider.test', US_ORIGIN: 'https://us.provider.test', DE_ORIGIN: 'https://de.provider.test', CF_SAAS_API_TOKEN: 'test', CLOUDFLARE_ZONE_ID: 'zone', DB: d1()};
  for (const id of ready) setRoute(env, {id, customerId: id, status: 'ready'});
  const call = (action, tenantId = first, hostname = host) => domainAction(env, action, {hostname, tenantId});
  return {env, call};
}
// Stands in for the Cloudflare custom-hostname API and public DNS.
function remote(f, {used = 0, certificate = 'active', proof = true, pointed = true} = {}) {
  const original = globalThis.fetch;
  const calls = [];
  let created = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({url: url.toString(), method: options.method || 'GET'});
    if (url.host === 'cloudflare-dns.com') {
      const row = readDomainRow(f.env, url.searchParams.get('name').replace(/^_spartan-verification\./, ''));
      return Response.json({Status: 0, Answer: url.searchParams.get('type') === 'TXT'
        ? (proof && row ? [{name: `_spartan-verification.${row.hostname}`, type: 16, data: `"${row.token}"`}] : [])
        : (pointed ? [{name: url.searchParams.get('name'), type: 5, data: 'cloud.provider.test.'}] : [])});
    }
    if (url.pathname.endsWith('/quota')) return Response.json({success: true, result: {used}});
    if (url.searchParams.has('hostname')) return Response.json({success: true, result: created ? [created] : []});
    if (options.method === 'POST') { created = {id: 'cf-1', hostname: host}; return Response.json({success: true, result: created}); }
    if (options.method === 'DELETE') { created = null; return Response.json({success: true, result: {id: 'cf-1'}}); }
    return Response.json({success: true, result: {id: 'cf-1', hostname: host, status: 'active', ssl: {status: certificate, method: 'http'}, ownership_verification: {name: 'o', value: 'v'}}});
  };
  return {calls, restore: () => { globalThis.fetch = original; }};
}

test('D1 reservation is idempotent and cannot bind one hostname to two tenants', async () => {
  const f = fixture();
  const created = await f.call('reserve');
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.ownership.name, `_spartan-verification.${host}`);
  assert.equal(body.cname.target, 'cloud.provider.test');
  assert.equal(body.cname.proxied, false);
  const again = await f.call('reserve');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).ownership.value, body.ownership.value);
  assert.equal((await f.call('reserve', second)).status, 409);
  assert.equal((await f.call('resolve')).status, 404);
});

test('D1 verify refuses an unready tenant and an unproven hostname without calling Cloudflare', async () => {
  const f = fixture({ready: []});
  assert.equal((await f.call('reserve')).status, 409);
  setRoute(f.env, {id: first, status: 'ready'});
  await f.call('reserve');
  const mock = remote(f, {proof: false});
  try {
    assert.equal((await f.call('verify')).status, 409);
    assert.equal(mock.calls.some(c => c.method === 'POST'), false, 'must not register before ownership is proven');
    assert.equal((await f.call('resolve')).status, 404);
  } finally { mock.restore(); }
});

test('proven ownership registers the Cloudflare hostname automatically and then resolves', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f);
  try {
    const verified = await f.call('verify');
    assert.equal(verified.status, 200);
    const body = await verified.json();
    assert.equal(body.status, 'active');
    assert.equal(body.ssl.status, 'active');
    assert.equal(body.ssl.managed, true);
    assert.equal(mock.calls.filter(c => c.method === 'POST').length, 1, 'registers exactly once');
    assert.deepEqual(await (await f.call('resolve')).json(), {id: first});
    assert.equal((await f.call('resolve', first, 'other.customer.test')).status, 404);
  } finally { mock.restore(); }
});

test('a pending certificate or a wrong CNAME target never resolves', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f, {certificate: 'pending_validation'});
  try {
    assert.equal((await (await f.call('verify')).json()).status, 'pending_certificate');
    assert.equal((await f.call('resolve')).status, 404);
  } finally { mock.restore(); }
  const g = fixture();
  await g.call('reserve');
  const other = remote(g, {pointed: false});
  try {
    assert.equal((await (await g.call('verify')).json()).status, 'pending_certificate');
    assert.equal((await g.call('resolve')).status, 404);
  } finally { other.restore(); }
});

test('the hostname slot count falls on delete, so churn no longer locks the account out', async () => {
  const f = fixture();
  await f.call('reserve');
  assert.equal(await countCloudflareSlots(f.env), 0);
  const mock = remote(f);
  try {
    await f.call('verify');
    assert.equal(await countCloudflareSlots(f.env), 1, 'a registered hostname holds a slot');
    assert.equal((await f.call('delete', second)).status, 409, 'another tenant cannot detach it');
    assert.equal((await f.call('delete')).status, 200);
    // The Durable Object kept a monotonic budgetUsed counter that never decremented, so a
    // hundred reserve/delete cycles permanently exhausted the guard. COUNT(*) cannot drift.
    assert.equal(await countCloudflareSlots(f.env), 0, 'deleting frees the slot');
    assert.equal(await countDomains(f.env), 0);
    assert.equal((await f.call('resolve')).status, 404);
  } finally { mock.restore(); }
});

test('the free-hostname guard still refuses to exceed the included allowance', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f, {used: 100});
  try {
    assert.equal((await f.call('verify')).status, 409);
    assert.equal(mock.calls.some(c => c.method === 'POST'), false);
  } finally { mock.restore(); }
});

test('only one concurrent verify may register the hostname', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f);
  try {
    const [left, right] = await Promise.all([f.call('verify'), f.call('verify')]);
    assert.equal(left.status < 400 && right.status < 400, true);
    assert.equal(mock.calls.filter(c => c.method === 'POST').length, 1, 'the create lock prevents a double registration');
    assert.equal(await countCloudflareSlots(f.env), 1);
  } finally { mock.restore(); }
});

test('the configured reservation limit is enforced', async () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) assert.equal((await f.call('reserve', first, `billing.customer${i}.test`)).status, 201);
  assert.equal((await f.call('reserve', first, 'billing.customer30.test')).status, 409);
  assert.equal((await f.call('reserve', first, 'billing.customer0.test')).status, 200, 'an existing reservation still reads back');
});

test('the cron sweep re-checks due domains in place of the Durable Object alarm', async () => {
  const f = fixture();
  await f.call('reserve');
  const pending = remote(f, {certificate: 'pending_validation'});
  try { await f.call('verify'); } finally { pending.restore(); }
  let record = await readDomain(f.env, host);
  assert.equal(record.status, 'pending_certificate');
  assert.ok(record.nextCheckAt > Date.now(), 'a pending certificate is scheduled for another check');
  assert.equal(await monitorDomains(f.env, 0), 0, 'nothing is due yet');
  const issued = remote(f);
  try { assert.equal(await monitorDomains(f.env, record.nextCheckAt + 1), 1); }
  finally { issued.restore(); }
  record = await readDomain(f.env, host);
  assert.equal(record.status, 'active');
  assert.ok(record.nextCheckAt > Date.now() + 21500000, 'an active certificate backs off to a long interval');
  assert.deepEqual(await (await f.call('resolve')).json(), {id: first});
});

test('reserved and malformed hostnames are refused', async () => {
  const f = fixture();
  for (const name of ['cloud.provider.test', 'tenant.cloud.provider.test', 'provider.test', 'us.provider.test', '*.customer.test', 'no-dot', '']) {
    assert.equal((await f.call('reserve', first, name)).status, 400, name);
  }
});

test('domain verification reports missing configuration without disclosing secrets', async () => {
  const f = fixture();
  await f.call('reserve');
  delete f.env.CF_SAAS_API_TOKEN;
  const stub = remote(f);
  try {
    const response = await f.call('verify');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: 'domain_operation_failed', reason: 'saas_configuration_required', missingSettings: ['CF_SAAS_API_TOKEN']});
  } finally { stub.restore(); }
});

test('domain verification returns Cloudflare status and numeric codes without raw upstream messages', async () => {
  const f = fixture();
  await f.call('reserve');
  const stub = remote(f);
  const dnsFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => new URL(url).hostname === 'api.cloudflare.com'
    ? Promise.resolve(Response.json({success: false, errors: [{code: 10000, message: 'secret-upstream-detail'}]}, {status: 403}))
    : dnsFetch(url, options);
  try {
    const response = await f.call('verify');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: 'domain_operation_failed', reason: 'cloudflare_403', cloudflareCodes: [10000]});
  } finally { stub.restore(); }
});


test('failed custom hostname creation can retry after the lease without duplicate immediate creates', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f);
  const remoteFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      posts++;
      if (posts === 1) return Response.json({success: false, errors: [{code: 10000}]}, {status: 500});
    }
    return remoteFetch(url, options);
  };
  const now = Date.now();
  try {
    assert.equal((await domainAction(f.env, 'verify', {hostname: host, tenantId: first}, now)).status, 503);
    await domainAction(f.env, 'verify', {hostname: host, tenantId: first}, now + 60000);
    assert.equal(posts, 1);
    const retry = await domainAction(f.env, 'verify', {hostname: host, tenantId: first}, now + 300001);
    assert.equal(posts, 2);
    assert.equal((await retry.json()).status, 'active');
  } finally {mock.restore();}
});
