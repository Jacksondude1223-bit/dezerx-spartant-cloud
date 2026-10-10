import test from 'node:test';
import assert from 'node:assert/strict';
import {onboardingAction} from '../workers/onboarding.js';
import {readRoute, readDomain} from '../workers/store.js';
import {issueDomainPermit, verifyDomainPermit} from '../node/domain-permit.mjs';
import {d1} from './d1.mjs';
import routing from '../workers/routing.js';
import {signature} from '../workers/shared.js';

const id = `t-${'a'.repeat(24)}`;
const name = 'panel.customer.test';
const secret = 's'.repeat(64);
const input = {id, serviceId: 'service_1', customerId: 'customer_1', primary: 'us', hostname: name};
const fixture = () => ({DB: d1(), ORIGIN_SECRET: secret, BASE_DOMAIN: 'cloud.provider.test', SAAS_ZONE_DOMAIN: 'provider.test', SAAS_CNAME_TARGET: 'cloud.provider.test', US_ORIGIN: 'https://us.provider.test', DE_ORIGIN: 'https://de.provider.test', CLOUDFLARE_ZONE_ID: 'zone', CF_SAAS_API_TOKEN: 'test', CF_ROUTING_API_TOKEN: 'routing', ROUTING_WORKER_NAME: 'router'});

test('onboarding endpoints require backend HMAC authentication and enforce service ownership', async () => {
  const env = fixture();
  const path = '/v1/routing/onboarding/prepare';
  const body = JSON.stringify(input);
  const url = `https://${env.BASE_DOMAIN}${path}`;
  assert.equal((await routing.fetch(new Request(url, {method: 'POST', body}), env)).status, 401);
  const call = async value => {
    const payload = JSON.stringify(value);
    const stamp = String(Date.now());
    return routing.fetch(new Request(url, {method: 'POST', body: payload, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, 'POST', path, payload)}}), env);
  };
  assert.equal((await call(input)).status, 201);
  assert.equal((await call(input)).status, 200);
  assert.equal((await call({...input, customerId: 'another_customer'})).status, 409);
});

test('domain permit rejects tampering, expiry, another tenant or another hostname', async () => {
  const permit = await issueDomainPermit(secret, id, name, 1000000);
  assert.equal(await verifyDomainPermit(permit.token, secret, id, name, 1000001), true);
  for (const [token, key, tenant, host, now] of [
    [permit.token, secret, id, name, permit.expiresAt],
    [permit.token, secret, `t-${'b'.repeat(24)}`, name, 1000001],
    [permit.token, secret, id, 'other.customer.test', 1000001],
    [permit.token, 'x'.repeat(64), id, name, 1000001],
    [permit.token + 'x', secret, id, name, 1000001],
  ]) assert.equal(await verifyDomainPermit(token, key, tenant, host, now), false);
});

test('onboarding prepares without containers and verifies ownership, SSL and routing before issuing a permit', async () => {
  const env = fixture();
  const oldFetch = globalThis.fetch;
  let proof = false, ssl = 'pending_validation', created = false, pointed = true, routes = [];
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = new URL(url);
    calls.push({url: url.href, method: options.method || 'GET'});
    if (url.hostname === 'cloudflare-dns.com') {
      const token = (await readDomain(env, name)).token;
      return Response.json({Status: 0, Answer: url.searchParams.get('type') === 'TXT'
        ? proof ? [{type: 16, name: `_spartan-verification.${name}`, data: `"${token}"`}] : []
        : pointed ? [{type: 5, name, data: 'cloud.provider.test.'}] : []});
    }
    if (url.pathname.endsWith('/workers/routes')) {
      if (options.method === 'POST') { const route = JSON.parse(options.body); routes.push(route); return Response.json({success: true, result: route}); }
      return Response.json({success: true, result: routes});
    }
    if (url.pathname.endsWith('/quota')) return Response.json({success: true, result: {used: 0}});
    if (url.searchParams.has('hostname')) return Response.json({success: true, result: created ? [{id: 'cf1', hostname: name}] : []});
    if (options.method === 'POST') {
      assert.equal(JSON.parse(options.body).ssl.method, 'txt');
      created = true;
      return Response.json({success: true, result: {id: 'cf1'}});
    }
    return Response.json({success: true, result: {hostname: name, status: 'active', ownership_verification: {type: 'txt', name: `_cf-custom-hostname.${name}`, value: 'ownership-token'}, ssl: {status: ssl, method: 'txt', validation_records: [{txt_name: `_acme-challenge.${name}`, txt_value: 'certificate-token'}]}}});
  };
  try {
    const prepare = await (await onboardingAction(env, 'prepare', input)).json();
    assert.equal(prepare.required, true);
    assert.equal(prepare.readyToProvision, false);
    assert.equal((await readRoute(env, id)).status, 'pending');
    assert.equal(calls.length, 0);
    assert.equal(prepare.dnsRecords.some(record => record.purpose === 'spartan_ownership'), true);
    assert.equal((await onboardingAction(env, 'prepare', {...input, customerId: 'other'})).status, 409);
    const unproven = await (await onboardingAction(env, 'verify', input)).json();
    assert.equal(unproven.domainVerificationToken, undefined);
    assert.equal(created, false);
    proof = true;
    const pending = await (await onboardingAction(env, 'verify', input)).json();
    assert.equal(pending.readyToProvision, false);
    assert.equal(pending.dnsRecords.some(record => record.name === `_cf-custom-hostname.${name}`), true);
    assert.equal(pending.dnsRecords.some(record => record.name === `_acme-challenge.${name}`), true);
    assert.equal(pending.domainVerificationToken, undefined);
    ssl = 'active'; pointed = false;
    assert.equal((await (await onboardingAction(env, 'verify', input)).json()).readyToProvision, false);
    pointed = true;
    const verified = await (await onboardingAction(env, 'verify', input)).json();
    assert.equal(verified.readyToProvision, true);
    assert.equal(verified.required, false);
    assert.equal(await verifyDomainPermit(verified.domainVerificationToken, secret, id, name), true);
    assert.deepEqual(routes, [{pattern: 'cloud.provider.test/*', script: 'router'}, {pattern: `${name}/*`, script: 'router'}]);
    assert.equal((await readRoute(env, id)).status, 'pending');
    const status = await (await onboardingAction(env, 'status', input)).json();
    assert.equal(status.readyToProvision, true);
    assert.equal(status.domainVerificationToken, undefined);
    routes.find(route => route.pattern === `${name}/*`).script = 'another-worker';
    const conflict = await (await onboardingAction(env, 'verify', input)).json();
    assert.equal(conflict.readyToProvision, false);
    assert.equal(conflict.error, 'customer_route_conflict');
  } finally {globalThis.fetch = oldFetch;}
});
