import test from 'node:test';
import assert from 'node:assert/strict';
import routing from '../workers/routing.js';
import {routingStatus} from '../workers/status-page.js';
import {d1, setRoute} from './d1.mjs';
const env = {BASE_DOMAIN: 'cloud.example.com', US_ORIGIN: 'https://node-us.example.com', DE_ORIGIN: 'https://node-de.example.com'};
function request(path = '/', headers = {}, cf = {}) {
  const req = new Request(`https://routing.workers.dev${path}`, {headers});
  Object.defineProperty(req, 'cf', {value: cf});
  return req;
}
test('Worker landing page displays the joke, current hostname and trusted visitor IP', async () => {
  const response = await routing.fetch(request('/', {'cf-connecting-ip': '198.51.100.15', 'x-forwarded-for': '1.2.3.4'}, {country: 'US', colo: 'BOS'}), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const html = await response.text();
  for (const text of ['/__spartan_meme/meme.mp4', 'autoplay muted loop playsinline', 'free server', 'Jokes on you', '198.51.100.15', 'routing.workers.dev', 'Cloudflare edge', 'Not configured', 'BOS']) assert.ok(html.includes(text), text);
  assert.equal(html.includes('1.2.3.4'), false);
});
test('status refresh recovers original IPv6 and never trusts supplied forwarding headers', async () => {
  const response = await routing.fetch(request('/__routing_status', {'cf-connecting-ip': '240.0.0.2', 'cf-connecting-ipv6': '2001:db8::15'}, {country: 'DE'}), env);
  const status = await response.json();
  assert.equal(status.ip, '2001:db8::15');
  assert.equal(status.node, 'Germany');
  const unavailable = await routingStatus(request('/', {'x-forwarded-for': '1.2.3.4'}), env);
  assert.equal(unavailable.ip, 'Unavailable');
});
test('node connection is confirmed by an authenticated probe and mismatched regions fail closed', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const configured = {...env, US_ORIGIN: 'https://us.origin.test', ORIGIN_SECRET: 'private-origin-secret'};
  let received;
  globalThis.fetch = async (url, init) => { received = {url: String(url), headers: init.headers}; return Response.json({status: 'ready', region: 'us'}); };
  const status = await routingStatus(request(), configured);
  assert.equal(status.connection, 'Connected');
  assert.equal(status.connectedTo, 'United States node');
  assert.equal(received.url, 'https://us.origin.test/__cloud_node_health');
  assert.equal(received.headers['x-spartan-origin'], configured.ORIGIN_SECRET);
  assert.equal(JSON.stringify(status).includes(configured.ORIGIN_SECRET), false);
  globalThis.fetch = async () => Response.json({status: 'ready', region: 'de'});
  assert.equal((await routingStatus(request(), configured)).connection, 'Not connected');
  globalThis.fetch = async () => { throw new Error('timeout'); };
  assert.equal((await routingStatus(request(), configured)).connection, 'Not connected');
});
test('request metadata is escaped in HTML and HEAD responses have no body', async () => {
  const response = await routing.fetch(request('/', {}, {colo: '<img src=x onerror=alert(1)>'}), env);
  const html = await response.text();
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;img'));
  const head = await routing.fetch(new Request('https://routing.workers.dev/', {method: 'HEAD'}), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('unmapped custom hostnames display the landing page instead of raw JSON', async () => {
  const unmapped = {...env, DOMAINS: {getByName() { return {async fetch() { return Response.json({error: 'not_found'}, {status: 404}); }}; }}};
  const response = await routing.fetch(new Request('https://custom.provider.test/', {headers: {accept: 'text/html', 'cf-connecting-ip': '198.51.100.22'}}), unmapped);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-spartan-page'), 'routing-status-v1');
  const html = await response.text();
  assert.ok(html.includes('custom.provider.test'));
  assert.ok(html.includes('198.51.100.22'));
  assert.ok(html.includes('Jokes on you'));
  const refresh = await routing.fetch(new Request('https://custom.provider.test/__routing_status', {headers: {'cf-connecting-ip': '198.51.100.22'}}), unmapped);
  assert.equal((await refresh.json()).hostname, 'custom.provider.test');
  const api = await routing.fetch(new Request('https://custom.provider.test/unknown-api', {method: 'POST', body: '{}'}), unmapped);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), {error: 'not_found'});
});

test('browser requests for registered customer homepages still reach their own panel', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const id = 't-' + 'c'.repeat(24);
  const configured = {...env, US_ORIGIN: 'https://us.origin.test', ORIGIN_SECRET: 'secret', DB: d1()};
  setRoute(configured, {id, status: 'ready'});
  globalThis.fetch = async request => { assert.equal(request.url, `https://us.origin.test/tenant/${id}/`); return new Response('customer-panel'); };
  const response = await routing.fetch(new Request(`https://${id}.cloud.example.com/`, {headers: {accept: 'text/html', 'cf-connecting-ip': '198.51.100.22'}}), configured);
  assert.equal(await response.text(), 'customer-panel');
  assert.equal(response.headers.has('x-spartan-page'), false);
});

test('meme video requests use the asset binding and preserve range requests', async () => {
  let observed;
  const assets = {async fetch(request) { observed = request; return new Response('video-bytes', {status: 206, headers: {'content-type': 'video/mp4', 'content-range': 'bytes 0-10/874215'}}); }};
  const response = await routing.fetch(new Request('https://routing.workers.dev/__spartan_meme/meme.mp4', {headers: {range: 'bytes=0-10'}}), {...env, ASSETS: assets});
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(observed.headers.get('range'), 'bytes=0-10');
  const unmapped = {...env, ASSETS: assets, DB: d1()};
  const custom = await routing.fetch(new Request('https://custom.provider.test/__spartan_meme/meme.mp4'), unmapped);
  assert.equal(custom.status, 206);
  assert.equal(observed.url, 'https://custom.provider.test/__spartan_meme/meme.mp4');
});

test('registered customer media paths continue to their own application', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const id = 't-' + 'd'.repeat(24);
  const configured = {...env, US_ORIGIN: 'https://us.origin.test', ORIGIN_SECRET: 'secret', ASSETS: {async fetch() { throw new Error('customer_asset_intercepted'); }}, DB: d1()};
  setRoute(configured, {id, status: 'ready'});
  globalThis.fetch = async request => { assert.equal(request.url, `https://us.origin.test/tenant/${id}/__spartan_meme/meme.mp4`); return new Response('customer-media'); };
  const response = await routing.fetch(new Request(`https://${id}.cloud.example.com/__spartan_meme/meme.mp4`, {headers: {'cf-connecting-ip': '198.51.100.22'}}), configured);
  assert.equal(await response.text(), 'customer-media');
});
