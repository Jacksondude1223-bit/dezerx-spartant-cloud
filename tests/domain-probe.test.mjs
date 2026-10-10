import test from 'node:test';
import assert from 'node:assert/strict';
import routing from '../workers/routing.js';
import {onboardingAction} from '../workers/onboarding.js';
import {readDomain, updateDomain, registerRoute} from '../workers/store.js';
import {verifyDomainPermit} from '../node/domain-permit.mjs';
import {PROBE_PATH, reachesRouter} from '../workers/domain-probe.js';
import {d1} from './d1.mjs';

const id = `t-${'a'.repeat(24)}`;
const hostname = 'panel.customer.test';
const input = {id, hostname, serviceId: 'service', customerId: 'customer', primary: 'us'};
const fixture = () => ({DB: d1(), ORIGIN_SECRET: 's'.repeat(64), BASE_DOMAIN: 'cloud.provider.test', SAAS_ZONE_DOMAIN: 'provider.test', SAAS_CNAME_TARGET: 'cloud.provider.test', US_ORIGIN: 'https://us.provider.test', DE_ORIGIN: 'https://de.provider.test', CLOUDFLARE_ZONE_ID: 'zone', CF_SAAS_API_TOKEN: 'test', CF_ROUTING_API_TOKEN: 'routing', ROUTING_WORKER_NAME: 'router'});

test('proxied onboarding requires TXT, active SSL, target route and a fresh authentic customer-host probe', async () => {
  const env = fixture();
  const oldFetch = globalThis.fetch;
  let owned = false, ssl = 'pending_validation', created = false, mode = 'unreachable', probes = 0;
  const routes = [];
  globalThis.fetch = async (value, options = {}) => {
    const url = new URL(value);
    if (url.hostname === 'cloudflare-dns.com') {
      const record = await readDomain(env, hostname);
      return Response.json({Status: 0, Answer: url.searchParams.get('type') === 'TXT' && owned ? [{type: 16, name: `_spartan-verification.${hostname}`, data: `"${record.token}"`}] : []});
    }
    if (url.pathname.endsWith('/workers/routes')) {
      if (options.method === 'POST') {const route = JSON.parse(options.body); routes.push(route); return Response.json({success: true, result: route});}
      return Response.json({success: true, result: routes});
    }
    if (url.hostname === hostname) {
      probes++;
      assert.equal(options.redirect, 'manual');
      if (mode === 'unreachable') throw new Error('unreachable');
      if (mode === 'redirect') return new Response(null, {status: 302, headers: {location: `https://${env.BASE_DOMAIN}${PROBE_PATH}${url.search}`}});
      if (mode === 'challenge') return new Response('challenge', {status: 403});
      if (mode === 'fake') return Response.json({hostname, tenantId: id, nonce: url.searchParams.get('nonce'), signature: '0'.repeat(64)});
      const response = await routing.fetch(new Request(url), env);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const data = await response.json();
      if (mode === 'replay') data.nonce = '0'.repeat(64);
      if (mode === 'wrong-host') data.hostname = 'other.customer.test';
      if (mode === 'wrong-tenant') data.tenantId = `t-${'b'.repeat(24)}`;
      return Response.json(data);
    }
    if (url.pathname.endsWith('/quota')) return Response.json({success: true, result: {used: 0}});
    if (url.searchParams.has('hostname')) return Response.json({success: true, result: created ? [{id: 'cf1', hostname}] : []});
    if (options.method === 'POST') {created = true; return Response.json({success: true, result: {id: 'cf1'}});}
    return Response.json({success: true, result: {hostname, status: 'active', ssl: {status: ssl, method: 'txt'}}});
  };
  try {
    const prepared = await (await onboardingAction(env, 'prepare', input)).json();
    assert.equal(prepared.cname.proxySupported, true);
    assert.deepEqual(prepared.cname.proxyModes, ['dns_only', 'cloudflare_proxied']);
    assert.equal((await (await onboardingAction(env, 'verify', input)).json()).readyToProvision, false);
    assert.equal(created, false);
    assert.equal(probes, 0);
    owned = true;
    assert.equal((await (await onboardingAction(env, 'verify', input)).json()).readyToProvision, false);
    assert.equal(probes, 0);
    ssl = 'active';
    for (mode of ['unreachable', 'redirect', 'challenge', 'fake', 'replay', 'wrong-host', 'wrong-tenant']) {
      const result = await (await onboardingAction(env, 'verify', input)).json();
      assert.equal(result.readyToProvision, false, mode);
      assert.equal(result.domainVerificationToken, undefined, mode);
    }
    mode = 'valid';
    const result = await (await onboardingAction(env, 'verify', input)).json();
    assert.equal(result.readyToProvision, true);
    assert.equal(await verifyDomainPermit(result.domainVerificationToken, env.ORIGIN_SECRET, id, hostname), true);
    assert.deepEqual(routes, [{pattern: `${env.SAAS_CNAME_TARGET}/*`, script: 'router'}, {pattern: `${hostname}/*`, script: 'router'}]);
    routes[0].script = 'other';
    const conflict = await (await onboardingAction(env, 'verify', input)).json();
    assert.equal(conflict.readyToProvision, false);
    assert.equal(conflict.error, 'customer_route_conflict');
  } finally {globalThis.fetch = oldFetch;}
});

test('probe refuses unknown domains, invalid requests and suspended tenants, with bounded upstream responses', async () => {
  const env = fixture();
  await onboardingAction(env, 'prepare', input);
  const url = `https://${hostname}${PROBE_PATH}?nonce=${'a'.repeat(64)}`;
  assert.equal((await routing.fetch(new Request(url), env)).status, 404);
  await updateDomain(env, hostname, {cloudflareId: 'cf1', status: 'pending_certificate'});
  assert.equal((await routing.fetch(new Request(url), env)).status, 200);
  assert.equal((await routing.fetch(new Request(url, {method: 'POST'}), env)).status, 404);
  assert.equal((await routing.fetch(new Request(url.replace('https:', 'http:')), env)).status, 404);
  assert.equal((await routing.fetch(new Request(url.replace('nonce=', 'other=')), env)).status, 404);
  await registerRoute(env, {...input, status: 'suspended', lifecycleVersion: 1});
  assert.equal((await routing.fetch(new Request(url), env)).status, 404);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('x'.repeat(3000), {headers: {'content-type': 'application/json'}});
  try {assert.equal(await reachesRouter(env, hostname, id), false);} finally {globalThis.fetch = oldFetch;}
});
