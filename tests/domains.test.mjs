import test from 'node:test';
import assert from 'node:assert/strict';
import {Domains, hostname} from '../workers/domains.js';
import routing from '../workers/routing.js';

const first = `t-${'a'.repeat(24)}`;
const second = `t-${'b'.repeat(24)}`;
function fixture() {
  const values = new Map();
  const storage = {async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); }, async delete(key) { values.delete(key); }, async setAlarm(value) { values.set('alarm', value); }, async list({prefix}) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); }};
  const env = {BASE_DOMAIN: 'cloud.provider.test', SAAS_ZONE_DOMAIN: 'provider.test', SAAS_CNAME_TARGET: 'cloud.provider.test', US_ORIGIN: 'https://us.provider.test', DE_ORIGIN: 'https://de.provider.test', CF_SAAS_API_TOKEN: 'test', CLOUDFLARE_ZONE_ID: 'zone', ORIGIN_SECRET: 'test', TENANTS: {getByName(id) { return {fetch: async () => Response.json({id, status: 'ready'})}; }}};
  const domains = new Domains({storage}, env);
  env.DOMAINS = {getByName() { return {fetch: (url, init) => domains.fetch(new Request(url, init))}; }};
  const call = (action, tenantId = first, name = 'billing.customer.test') => domains.fetch(new Request(`https://domains/${action}`, {method: 'POST', body: JSON.stringify({hostname: name, tenantId})}));
  return {env, values, call, domains};
}
function remote(f, {used = 0, certificate = 'active', proof = true, pointed = true} = {}) {
  const original = globalThis.fetch;
  const calls = [];
  let created = false;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({url: url.toString(), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined});
    const record = f.values.get('domain:billing.customer.test');
    if (url.host === 'cloudflare-dns.com') {
      const type = url.searchParams.get('type');
      return Response.json({Status: 0, Answer: type === 'TXT' ? (proof ? [{name: '_spartan-verification.billing.customer.test', type: 16, data: `"${record.token}"`}] : []) : (pointed ? [{name: 'billing.customer.test', type: 5, data: 'cloud.provider.test.'}] : [])});
    }
    if (url.pathname.endsWith('/quota')) return Response.json({success: true, result: {used}});
    if (url.searchParams.has('hostname')) return Response.json({success: true, result: created ? [{id: 'remote', hostname: 'billing.customer.test'}] : []});
    if (options.method === 'POST') { created = true; return Response.json({success: true, result: {id: 'remote'}}); }
    if (options.method === 'DELETE') return Response.json({success: true, result: {id: 'remote'}});
    return Response.json({success: true, result: {id: 'remote', hostname: 'billing.customer.test', status: 'active', ssl: {status: certificate, validation_records: []}}});
  };
  return {calls, restore() { globalThis.fetch = original; }};
}
test('hostnames reject provider names, URLs, wildcards and malformed hosts', () => {
  const {env} = fixture();
  assert.equal(hostname('Billing.Customer.Test.', env), 'billing.customer.test');
  for (const value of ['provider.test', 'cloud.provider.test', 'us.provider.test', 'https://customer.test', '*.customer.test', 'customer.test/evil', '-bad.customer.test']) assert.throws(() => hostname(value, env));
});
test('domain reservation is idempotent and cannot bind one hostname to two tenants', async () => {
  const f = fixture();
  const original = await (await f.call('reserve')).json();
  const repeated = await (await f.call('reserve')).json();
  assert.equal(original.ownership.value, repeated.ownership.value);
  assert.equal((await f.call('reserve', second)).status, 409);
  assert.equal((await f.call('resolve')).status, 404);
});
test('missing ownership proof never calls hostname registration API', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f, {proof: false});
  try {
    assert.equal((await f.call('verify')).status, 409);
    assert.equal(mock.calls.some(c => c.url.includes('api.cloudflare.com')), false);
    assert.equal((await f.call('resolve')).status, 404);
  } finally { mock.restore(); }
});
test('quota blocks the 101st hostname before any paid registration', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f, {used: 100});
  try {
    const response = await f.call('verify');
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'free_hostname_limit');
    assert.equal(mock.calls.some(c => c.method === 'POST'), false);
  } finally { mock.restore(); }
});
test('saved budget prevents overage when quota data lags behind new registrations', async () => {
  const f = fixture();
  await f.call('reserve');
  f.values.set('budgetUsed', 100);
  const mock = remote(f, {used: 0});
  try {
    assert.equal((await f.call('verify')).status, 409);
    assert.equal(mock.calls.some(c => c.method === 'POST'), false);
  } finally { mock.restore(); }
});
test('pending certificates and wrong CNAME targets cannot route', async () => {
  for (const options of [{certificate: 'pending_validation'}, {pointed: false}]) {
    const f = fixture();
    await f.call('reserve');
    const mock = remote(f, options);
    try {
      assert.equal((await (await f.call('verify')).json()).status, 'pending_certificate');
      assert.equal((await f.call('resolve')).status, 404);
    } finally { mock.restore(); }
  }
});
test('verified active domain resolves exclusively to its owning tenant', async () => {
  const f = fixture();
  await f.call('reserve');
  const mock = remote(f);
  try {
    assert.equal((await (await f.call('verify')).json()).status, 'active');
    assert.deepEqual(await (await f.call('resolve')).json(), {id: first});
    assert.equal((await f.call('verify', second)).status, 409);
    await f.call('verify');
    assert.equal(mock.calls.filter(c => c.method === 'POST').length, 1);
    assert.equal(f.values.get('budgetUsed'), 1);
    assert.equal((await f.call('delete', second)).status, 409);
    assert.equal((await f.call('delete')).status, 200);
    assert.equal((await f.call('resolve')).status, 404);
  } finally { mock.restore(); }
});
test('custom domain requests retain their hostname and use the mapped tenant path', async () => {
  const f = fixture();
  f.values.set('domain:billing.customer.test', {hostname: 'billing.customer.test', tenantId: first, status: 'active'});
  const original = globalThis.fetch;
  globalThis.fetch = async request => {
    assert.equal(new URL(request.url).pathname, `/tenant/${first}/invoices`);
    assert.equal(request.headers.get('x-spartan-host'), 'billing.customer.test');
    assert.equal(request.headers.get('x-spartan-custom-domain'), '1');
    return new Response('tenant');
  };
  try {
    const response = await routing.fetch(new Request('https://billing.customer.test/invoices', {headers: {'x-spartan-custom-domain': 'evil'}}), f.env);
    assert.equal(await response.text(), 'tenant');
    assert.equal((await routing.fetch(new Request('https://unknown.customer.test/'), f.env)).status, 404);
  } finally { globalThis.fetch = original; }
});

test('the 31st reservation is blocked by the configured default limit', async () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) assert.equal((await f.call('reserve', first, `billing.customer${i}.test`)).status, 201);
  assert.equal((await f.call('reserve', first, 'billing.customer30.test')).status, 409);
  assert.equal((await f.call('reserve', first, 'billing.customer0.test')).status, 200);
});
test('ownership proof starts managed HTTP certificate issuance automatically', async () => {
  const f = fixture();
  await f.call('reserve');
  assert.ok(f.values.get('alarm'));
  f.values.get('domain:billing.customer.test').nextCheckAt = 0;
  const mock = remote(f);
  try {
    await f.domains.alarm();
    const record = await (await f.call('status')).json();
    assert.equal(record.status, 'active');
    assert.equal(record.ssl.provider, 'cloudflare');
    assert.equal(record.ssl.automaticRenewal, true);
    assert.equal(mock.calls.find(call => call.method === 'POST').body.ssl.method, 'http');
    assert.ok(record.ssl.checkedAt);
    assert.ok(record.ssl.nextCheckAt > Date.now());
    assert.ok(f.values.get('alarm') > Date.now());
  } finally { mock.restore(); }
});
test('active certificates continue monitoring and loss of validation disables routing', async () => {
  const f = fixture();
  await f.call('reserve');
  const initial = remote(f);
  try { await f.call('verify'); } finally { initial.restore(); }
  f.values.get('domain:billing.customer.test').nextCheckAt = 0;
  const mock = remote(f, {certificate: 'expired'});
  try {
    await f.domains.alarm();
    const record = await (await f.call('status')).json();
    assert.equal(record.certificateStatus, 'expired');
    assert.equal(record.status, 'pending_certificate');
    assert.equal((await f.call('resolve')).status, 404);
    assert.equal(mock.calls.some(call => call.method === 'POST'), false);
    assert.ok(f.values.get('alarm') > Date.now());
  } finally { mock.restore(); }
});
test('temporary check failures preserve existing certificates and schedule another check', async () => {
  const f = fixture();
  await f.call('reserve');
  const initial = remote(f);
  try { await f.call('verify'); } finally { initial.restore(); }
  f.values.get('domain:billing.customer.test').nextCheckAt = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('timeout'); };
  try {
    await f.domains.alarm();
    const record = await (await f.call('status')).json();
    assert.equal(record.status, 'active');
    assert.equal(record.ssl.lastError, 'certificate_check_failed');
    assert.ok(record.ssl.nextCheckAt > Date.now());
  } finally { globalThis.fetch = previous; }
});
test('monitor wake-up resumes checks for records created before scheduling was added', async () => {
  const f = fixture();
  f.values.set('domain:billing.customer.test', {hostname: 'billing.customer.test', tenantId: first, status: 'active'});
  const response = await f.domains.fetch(new Request('https://domains/monitor', {method: 'POST', body: '{}'}));
  assert.equal(response.status, 200);
  assert.ok(f.values.get('alarm') >= Date.now());
});
