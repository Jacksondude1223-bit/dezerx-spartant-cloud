import test from 'node:test';
import assert from 'node:assert/strict';
import {d1, setRoute} from './d1.mjs';
import routing from '../workers/routing.js';
import {allocateHostname, resolveInstanceHostname} from '../workers/instance-hostnames.js';
import {signature} from '../workers/shared.js';
const id = 't-' + 'f'.repeat(24);
const secret = 'a'.repeat(64);
function environment() {
  const env = {DB: d1(), BASE_DOMAIN: 'load.dezerx.cloud', US_ORIGIN: 'https://node-us.dezerx.cloud', DE_ORIGIN: 'https://node-de.dezerx.cloud', SAAS_ZONE_DOMAIN: 'dezerx.cloud', INSTANCE_DOMAIN: 'dezerx.cloud', CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_ZONE_ID: 'zone', ROUTING_WORKER_NAME: 'dezerx-spartant-cloud', CF_INSTANCE_API_TOKEN: 'private-token', ORIGIN_SECRET: secret};
  setRoute(env, {id, status: 'pending'});
  return env;
}
test('default names are reserved before provisioning, idempotent under concurrent calls and attached to the correct Worker', async t => {
  const env = environment();
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    return Response.json({success: true, result: options.method === 'PUT' ? JSON.parse(options.body) : []});
  };
  const responses = await Promise.all([allocateHostname(env, id), allocateHostname(env, id)]);
  const [first, second] = await Promise.all(responses.map(response => response.json()));
  assert.match(first.url, /^https:\/\/instance-[1-9]\d{3}\.dezerx\.cloud$/);
  assert.equal(first.hostname, second.hostname);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS total FROM instance_hostnames').get().total, 1);
  assert.equal(await resolveInstanceHostname(env, first.hostname), id);
  assert.equal(calls.find(call => call.options.method === 'PUT').url, 'https://api.cloudflare.com/client/v4/accounts/account/workers/domains');
  assert.equal(JSON.stringify(first).includes('private-token'), false);
  const count = calls.length;
  assert.equal((await allocateHostname(env, id)).status, 200);
  assert.equal(calls.length, count);
  setRoute(env, {id, status: 'ready'});
  let target;
  globalThis.fetch = async request => {target = request; return new Response('panel');};
  assert.equal(await (await routing.fetch(new Request(first.url + '/billing', {headers: {'cf-connecting-ip': '198.51.100.1'}}), env)).text(), 'panel');
  assert.equal(target.url, 'https://node-us.dezerx.cloud/tenant/' + id + '/billing');
  assert.equal(target.headers.get('x-spartan-host'), first.hostname);
  setRoute(env, {id, status: 'suspended', lifecycleVersion: 1});
  assert.equal((await routing.fetch(new Request(first.url), env)).status, 403);
});
test('failed setup reserves a stable retryable name without making it routable', async t => {
  const env = environment();
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async () => Response.json({success: false}, {status: 403});
  const first = await (await allocateHostname(env, id)).json();
  assert.equal(first.error, 'instance_hostname_setup_failed');
  const next = await (await allocateHostname(env, id)).json();
  assert.equal(next.hostname, first.hostname);
  assert.equal(await resolveInstanceHostname(env, first.hostname), null);
  delete env.CF_INSTANCE_API_TOKEN;
  assert.equal((await allocateHostname(env, id)).status, 503);
});
test('hostname allocation requires signed control requests and never overrides another Worker', async t => {
  const env = environment();
  const pathname = `/v1/routing/instances/${id}/hostname`;
  assert.equal((await routing.fetch(new Request('https://load.dezerx.cloud' + pathname, {method: 'POST', body: '{}'}), env)).status, 401);
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async url => Response.json({success: true, result: [{hostname: new URL(url).searchParams.get('hostname'), service: 'different-worker', zone_id: 'zone'}]});
  const timestamp = String(Date.now());
  const response = await routing.fetch(new Request('https://load.dezerx.cloud' + pathname, {method: 'POST', body: '{}', headers: {'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(secret, timestamp, 'POST', pathname, '{}')}}), env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'instance_hostname_conflict');
});
