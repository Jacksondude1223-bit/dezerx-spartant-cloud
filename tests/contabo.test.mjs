import test from 'node:test';
import assert from 'node:assert/strict';
import {contaboClient, contaboSettings, firewallRules, firewallOperation} from '../dashboard-worker/contabo.mjs';

const id = 'b943b25a-c8b5-4570-9135-4bbaa7615b81';
const rule = {displayName: 'Peer database VPN', protocol: 'udp', destPorts: ['51820'], srcCidr: {ipv4: ['198.51.100.5/32'], ipv6: []}, action: 'accept', status: 'active'};
function fixture() {
  const env = {CONTABO_CLIENT_ID: 'test-client', CONTABO_CLIENT_SECRET: 'secret&with=encoding', CONTABO_API_USERNAME: 'operator@example.test', CONTABO_API_PASSWORD: 'password&+=value'};
  let firewall = {firewallId: id, name: 'Spartan nodes', description: '', status: 'inactive', rules: {inbound: [structuredClone(rule)]}, instances: [], instanceStatus: [], updatedDate: 'v0'};
  const instances = [{instanceId: 100, name: 'node-us', ipConfig: {v4: {ip: '198.51.100.5'}}, rootPassword: 'must-not-be-returned'}];
  const calls = [], audit = [], locks = new Set();
  let revision = 0, authStatus = 200, rejectOnce = false, forcedStatus = 0, paged = false;
  const fetch = async (url, options) => {
    calls.push({url, options});
    assert.equal(options.redirect, 'manual');
    const u = new URL(url);
    if (u.hostname === 'auth.contabo.com') {
      const body = new URLSearchParams(options.body);
      for (const [key, name] of [['client_id', 'CONTABO_CLIENT_ID'], ['client_secret', 'CONTABO_CLIENT_SECRET'], ['username', 'CONTABO_API_USERNAME'], ['password', 'CONTABO_API_PASSWORD']]) assert.equal(body.get(key), env[name]);
      assert.equal(body.get('grant_type'), 'password');
      return authStatus === 200 ? Response.json({access_token: 'server-only-access-token', expires_in: 300}) : Response.json({error: env.CONTABO_CLIENT_SECRET}, {status: authStatus});
    }
    assert.equal(u.origin, 'https://api.contabo.com');
    assert.match(options.headers['x-request-id'], /^[a-f0-9-]{36}$/);
    assert.equal(options.headers.authorization, 'Bearer server-only-access-token');
    if (rejectOnce) {rejectOnce = false; return Response.json({}, {status: 401});}
    if (forcedStatus) return Response.json({echo: env.CONTABO_CLIENT_SECRET}, {status: forcedStatus});
    if (options.method === 'GET') {
      if (u.pathname === '/v1/compute/instances') return Response.json({data: instances});
      if (u.pathname === '/v1/firewalls') return Response.json({data: paged && u.searchParams.get('page') === '1' ? [] : [firewall], _pagination: {totalPages: paged ? 2 : 1}});
      return Response.json({data: [firewall]});
    }
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    if (u.pathname.endsWith('/instances/100')) {
      if (options.method === 'POST') firewall.instances = instances;
      if (options.method === 'DELETE') firewall.instances = [];
    } else if (options.method === 'PUT') firewall.rules = body.rules;
    else if (options.method !== 'DELETE') firewall = {...firewall, ...body};
    firewall.updatedDate = 'v' + ++revision;
    return options.method === 'DELETE' ? new Response(null, {status: 204}) : Response.json({data: [firewall]});
  };
  const db = {async lock(name) {if (locks.has(name)) return null; locks.add(name); return 'lock';}, async unlock(name) {locks.delete(name);}, async audit(event, fields) {audit.push({event, ...fields});}};
  const client = contaboClient(env, fetch);
  const request = (path, body) => new Request('https://dashboard.example.test/api/firewall/' + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const operate = (path, body) => firewallOperation(request(path, body), env, db, 'operator', fetch);
  return {env, fetch, client, db, calls, audit, locks, operate, get firewall() {return firewall;}, set rejectOnce(x) {rejectOnce = x;}, set authStatus(x) {authStatus = x;}, set forcedStatus(x) {forcedStatus = x;}, set paged(x) {paged = x;}};
}

test('Contabo OAuth encodes credentials, joins concurrent authentication and follows every list page', async () => {
  const f = fixture(); f.paged = true;
  const data = await f.client.overview();
  assert.equal(data.firewalls.length, 1);
  assert.equal(f.calls.filter(x => x.url.includes('auth.contabo.com')).length, 1);
  assert.ok(f.calls.some(x => x.url.endsWith('page=2&size=100')));
  const serialized = JSON.stringify(data);
  for (const secret of [...Object.values(f.env), 'must-not-be-returned', 'server-only-access-token']) assert.equal(serialized.includes(secret), false);
  await f.client.get(id);
  assert.equal(f.calls.filter(x => x.url.includes('auth.contabo.com')).length, 1);
  const previous = f.env.CONTABO_CLIENT_SECRET;
  f.env.CONTABO_CLIENT_SECRET = 'rotated-client-secret';
  await contaboClient(f.env, f.fetch).get(id);
  assert.equal(f.calls.filter(x => x.url.includes('auth.contabo.com')).length, 2);
  f.env.CONTABO_CLIENT_SECRET = previous;
});

test('Contabo token rejection refreshes authentication once and provider errors never echo credentials', async () => {
  const f = fixture(); f.rejectOnce = true;
  await f.client.get(id);
  assert.equal(f.calls.filter(x => x.url.includes('auth.contabo.com')).length, 2);
  for (const [status, message] of [[403, 'contabo_permission_denied'], [402, 'contabo_addon_required'], [429, 'contabo_rate_limited'], [400, 'contabo_request_rejected']]) {
    f.forcedStatus = status;
    await assert.rejects(f.client.get(id), error => error.message === message && !JSON.stringify(error).includes(f.env.CONTABO_CLIENT_SECRET));
  }
  const bad = fixture(); bad.authStatus = 400;
  await assert.rejects(bad.client.get(id), /contabo_auth_failed/);
});

test('Contabo transport rejects redirects and arbitrary hosts and does not retry ambiguous timeouts', async () => {
  const f = fixture();
  await assert.rejects(f.client.call('GET', 'https://attacker.example.test'), /invalid_contabo_path/);
  assert.equal(f.calls.length, 0);
  const redirect = contaboClient(f.env, async () => new Response(null, {status: 302, headers: {location: 'https://attacker.example.test'}}));
  await assert.rejects(redirect.get(id), /contabo_redirect_rejected/);
  let attempts = 0;
  const timed = contaboClient(f.env, async () => {attempts++; throw Error(f.env.CONTABO_CLIENT_SECRET);});
  await assert.rejects(timed.get(id), /contabo_timeout/);
  assert.equal(attempts, 1);
});

test('firewall rules validate port ranges, protocol constraints and both IP families', () => {
  const result = firewallRules([{...rule, destPorts: ['00022', '22', '8000-8100'], srcCidr: {ipv4: ['198.51.100.5'], ipv6: ['2001:db8::/64', 'AnyIPv6']}}]);
  assert.deepEqual(result[0].destPorts, ['22', '8000-8100']);
  assert.deepEqual(result[0].srcCidr.ipv4, ['198.51.100.5/32']);
  for (const patch of [{destPorts: ['65536']}, {destPorts: ['90-80']}, {destPorts: ['22;curl']}, {protocol: 'icmp', destPorts: ['22']}, {protocol: '', destPorts: ['22']}, {action: 'drop'}, {protocol: 'invalid'}, {srcCidr: {ipv4: ['999.1.2.3']}}, {srcCidr: {ipv4: ['198.51.100.5/33']}}, {srcCidr: {ipv6: ['2001:db8::/129']}}, {srcCidr: {ipv6: ['bad::ip']}}, {srcCidr: {ipv4: ['AnyIPv6']}}]) assert.throws(() => firewallRules([{...rule, ...patch}]));
  assert.equal(firewallRules([{...rule, protocol: 'icmp', destPorts: []}])[0].protocol, 'icmp');
  assert.throws(() => firewallRules({}), /invalid_firewall_rules/);
});

test('firewall CRUD uses documented endpoints, confirmations, shared locks and current versions', async () => {
  const f = fixture();
  await assert.rejects(f.operate('create', {name: 'test'}), /firewall_confirmation_required/);
  assert.equal(f.calls.length, 0);
  const created = await f.operate('create', {confirmed: true, name: 'Fresh firewall', description: ''});
  assert.equal(created.firewallId, id);
  assert.equal(f.firewall.status, 'inactive');
  assert.deepEqual(f.firewall.rules.inbound, []);
  let current = await f.client.get(id);
  f.locks.add('contabo-firewall:' + id);
  await assert.rejects(f.operate(id + '/rules', {confirmed: true, version: current.version, rules: [rule]}), /firewall_busy/);
  f.locks.clear();
  await assert.rejects(f.operate(id + '/rules', {confirmed: true, version: 'stale', rules: [rule]}), /firewall_changed/);
  await f.operate(id + '/rules', {confirmed: true, version: current.version, rules: [rule]});
  assert.equal(f.calls.at(-1).options.method, 'PUT');
  current = await f.client.get(id);
  await f.operate(id + '/update', {confirmed: true, version: current.version, name: 'Shared firewall', description: 'Both nodes', status: 'active'});
  assert.equal(f.calls.at(-1).options.method, 'PATCH');
  current = await f.client.get(id);
  await f.operate(id + '/attach', {confirmed: true, version: current.version, instanceId: 100});
  assert.ok(f.calls.at(-1).url.endsWith('/instances/100'));
  current = await f.client.get(id);
  await assert.rejects(f.operate(id + '/delete', {confirmed: true, version: current.version}), /firewall_has_instances/);
  await assert.rejects(f.operate(id + '/detach', {confirmed: true, version: current.version, instanceId: 101}), /contabo_instance_not_attached/);
  await f.operate(id + '/detach', {confirmed: true, version: current.version, instanceId: 100});
  current = await f.client.get(id);
  await f.operate(id + '/delete', {confirmed: true, version: current.version});
  assert.equal(f.calls.at(-1).options.method, 'DELETE');
  assert.equal(f.locks.size, 0);
  assert.equal(f.audit.filter(x => x.event === 'firewall_change_completed').length, 6);
  assert.equal(JSON.stringify(f.audit).includes(f.env.CONTABO_CLIENT_SECRET), false);
});

test('firewall settings report only missing names and do not require Contabo for other dashboard features', () => {
  assert.equal(contaboSettings({}).missingSettings.length, 4);
  assert.equal(contaboSettings(fixture().env).configured, true);
  assert.throws(() => contaboClient({}), /contabo_configuration_required/);
});
