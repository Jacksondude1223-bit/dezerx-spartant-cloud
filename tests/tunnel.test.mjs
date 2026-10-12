import test from 'node:test';
import assert from 'node:assert/strict';
import {createTunnelInfo, parseTunnelMetrics, tunnelIdentity, tunnelConfiguration} from '../node/tunnel.mjs';

const tunnelId = '2551e490-663e-4fb7-b7b5-0fe468eca54a';
const connectorId = 'bba95636-e2f1-46d1-980d-ee481ce3bde0';
const accountId = 'a'.repeat(32);
const secret = 'never-return-this-token-secret';
const token = Buffer.from(JSON.stringify({a: accountId, t: tunnelId, s: secret})).toString('base64');
const cfg = {NODE_REGION: 'us', US_ORIGIN: 'https://node-us.example.test', DE_ORIGIN: 'https://node-de.example.test'};
const config = {version: 4, config: {ingress: [{hostname: 'node-us.example.test', service: 'http://127.0.0.1:8788', originRequest: {httpHostHeader: 'node-us.example.test', noTLSVerify: false, access: {secret}, httpHeaders: {authorization: secret}}}, {service: 'http_status:404'}], 'warp-routing': {enabled: false}, originRequest: {connectTimeout: '30s', caPool: '/secret-path', access: {secret}}}};
const metrics = `# HELP cloudflared_tunnel_ha_connections Active connections
cloudflared_tunnel_ha_connections 2
cloudflared_tunnel_server_locations{connection_id="0",edge_location="ORD",token="${secret}"} 1
cloudflared_tunnel_server_locations{connection_id="1",edge_location="FRA"} 1
cloudflared_tunnel_server_locations{connection_id="1",edge_location="LHR"} 0
cloudflared_tunnel_total_requests 100
cloudflared_tunnel_request_errors 3
cloudflared_tunnel_response_by_code{code="200",host="customer.example.test",secret="${secret}"} 97
cloudflared_tunnel_concurrent_requests_per_tunnel 2
cloudflared_tunnel_tunnel_register_fail{error="${secret}",rpcName="RegisterConnection"} 1
process_resident_memory_bytes 10485760
process_cpu_seconds_total 3.5
process_start_time_seconds 1791759477
quic_client_sent_bytes 1.5e+3
quic_client_receive_bytes 2000
cloudflared_bad_metric NaN
cloudflared_bad_metric Inf
custom_secret_metric 123
`;

test('tunnel token metadata and route configuration never include token secrets or origin credentials', () => {
  assert.deepEqual(tunnelIdentity(token), {tunnelId, accountId});
  assert.deepEqual(tunnelIdentity('invalid'), {tunnelId: null, accountId: null});
  assert.equal(tunnelIdentity(Buffer.from(JSON.stringify({t: 'bad', a: secret, s: secret})).toString('base64')).accountId, null);
  const data = tunnelConfiguration(config, 'node-us.example.test');
  assert.equal(data.nodeRoutePresent, true);
  assert.equal(data.routes[1].hostname, '');
  assert.equal(data.version, 4);
  const unsafe = structuredClone(config);
  unsafe.config.ingress[0].service = `https://user:${secret}@origin.example.test/path?key=${secret}#${secret}`;
  const sanitized = tunnelConfiguration(unsafe, 'node-us.example.test');
  assert.equal(sanitized.routes[0].service, 'https://origin.example.test/path');
  assert.equal(sanitized.nodeRoutePresent, false);
  for (const value of [data, sanitized]) assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(tunnelConfiguration({}, 'node-us.example.test'), null);
});

test('Prometheus tunnel metrics parse labels and scientific numbers while dropping arbitrary labels', () => {
  const values = parseTunnelMetrics(metrics);
  assert.equal(values.find(x => x.name === 'quic_client_sent_bytes').value, 1500);
  assert.deepEqual(values.find(x => x.name === 'cloudflared_tunnel_server_locations').labels, {connection_id: '0', edge_location: 'ORD'});
  assert.deepEqual(values.find(x => x.name === 'cloudflared_tunnel_response_by_code').labels, {code: '200'});
  assert.equal(values.some(x => x.name === 'custom_secret_metric' || !Number.isFinite(x.value)), false);
  assert.equal(JSON.stringify(values).includes(secret), false);
});

test('live tunnel diagnostics combine readiness, connection protocols, routes, metrics and service state', async () => {
  const calls = [], commands = [];
  let clock = Date.parse('2026-10-12T01:40:00Z'), reads = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual'); calls.push(url);
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, 'http://127.0.0.1:8789');
    if (path === '/ready') return Response.json({status: 200, readyConnections: 2, connectorId});
    if (path === '/diag/tunnel') return Response.json({tunnelID: tunnelId, connectorID: connectorId, token: secret, connections: [{isConnected: true, edgeAddress: '198.41.192.7'}, {index: 1, protocol: 1, isConnected: true, edgeAddress: '2606:4700::1', token: secret}]});
    if (path === '/config') return Response.json(config);
    if (path === '/metrics') return new Response(metrics);
    throw Error('Unexpected endpoint');
  };
  const run = async (command, args) => {commands.push({command, args}); return command === 'cloudflared' ? `cloudflared version 2026.10.0 (built 2026-10-05) ${secret}` : `ActiveState=active\nSubState=running\nMainPID=1234\nNRestarts=1\nExecMainStatus=0\nActiveEnterTimestamp=2026-10-12 01:00:00 UTC\nSecret=${secret}\n`;};
  const inspect = createTunnelInfo({cfg, fetchImpl, run, readToken: async () => {reads++; return token;}, now: () => clock});
  const [data, concurrent] = await Promise.all([inspect(), inspect()]);
  assert.equal(data, concurrent);
  assert.equal(data.status, 'connected'); assert.equal(data.activeConnections, 2);
  assert.equal(data.version, '2026.10.0'); assert.equal(data.service.pid, 1234);
  assert.equal(data.configuration.nodeRoutePresent, true);
  assert.equal(data.identityMatchesFile, true);
  assert.equal(data.connections[0].protocol, 'http2'); assert.equal(data.connections[0].location, 'ORD');
  assert.equal(data.connections[1].protocol, 'quic'); assert.equal(data.connections[1].location, 'FRA');
  assert.equal(data.counters.totalRequests, 100); assert.equal(data.counters.requestErrors, 3);
  assert.equal(data.counters.registrationFailures, 1); assert.equal(data.counters.processMemoryBytes, 10485760);
  assert.equal(data.accountId, accountId); assert.equal(data.connectorId, connectorId);
  for (const value of [secret, token]) assert.equal(JSON.stringify(data).includes(value), false);
  assert.equal(calls.length, 4); assert.equal(reads, 1);
  assert.deepEqual(commands.map(x => x.command), ['systemctl', 'cloudflared']);
  assert.equal(commands.some(x => x.args.includes('restart') || x.args.includes('ExecStart')), false);
  await inspect(); assert.equal(calls.length, 4);
  clock += 5001; await inspect(); assert.equal(calls.length, 8);
});

test('older connectors return partial diagnostics without inventing connection details', async () => {
  const fetchImpl = async url => new URL(url).pathname === '/ready' ? Response.json({readyConnections: 0}, {status: 503}) : new Response('', {status: 404});
  const inspect = createTunnelInfo({cfg, fetchImpl, run: async () => {throw Error(secret);}, readToken: async () => token});
  const data = await inspect();
  assert.equal(data.status, 'disconnected'); assert.equal(data.ready, false);
  assert.equal(data.configuration, null); assert.deepEqual(data.connections, []);
  assert.equal(data.availability.configuration, 'unsupported'); assert.equal(data.counters.totalRequests, null);
  assert.equal(data.tunnelId, tunnelId); assert.equal(data.version, null);
  assert.equal(JSON.stringify(data).includes(secret), false);
});

test('tunnel diagnostics reject redirects and oversized responses and do not expose collection errors', async () => {
  const oversized = createTunnelInfo({cfg, fetchImpl: async () => new Response('x'.repeat(1100000)), run: async () => '', readToken: async () => ''});
  const data = await oversized();
  assert.equal(data.availability.metrics, 'response_too_large');
  const redirected = createTunnelInfo({cfg, fetchImpl: async () => new Response(null, {status: 302, headers: {location: 'https://attacker.example.test'}}), run: async () => '', readToken: async () => ''});
  const blocked = await redirected();
  assert.equal(blocked.status, 'unknown'); assert.equal(blocked.availability.readiness, 'redirect_rejected');
  const failed = createTunnelInfo({cfg, fetchImpl: async () => {throw Error(secret);}, run: async () => {throw Error(secret);}, readToken: async () => {throw Error(secret);}});
  const missing = await failed();
  assert.equal(missing.status, 'unknown'); assert.equal(missing.activeConnections, null);
  assert.equal(JSON.stringify(missing).includes(secret), false);
});
