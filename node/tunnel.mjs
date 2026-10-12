import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open} from 'node:fs/promises';
import {isIP} from 'node:net';
import {constants} from 'node:fs';

const exec = promisify(execFile);
const LOCAL = 'http://127.0.0.1:8789';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const string = (value, maximum = 255) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maximum) : '';

async function tokenFile() {
  const file = await open('/etc/spartan-cloud/tunnel-token', constants.O_RDONLY | constants.O_NOFOLLOW);
  try {const stat = await file.stat(); if (!stat.isFile() || stat.size > 16384) return ''; return await file.readFile('utf8');} finally {await file.close();}
}
export function tunnelIdentity(token) {
  try {
    const value = JSON.parse(Buffer.from(String(token).trim(), 'base64').toString('utf8'));
    return {tunnelId: uuid(value.t), accountId: typeof value.a === 'string' && /^[a-f0-9]{32}$/i.test(value.a) ? value.a : null};
  } catch {return {tunnelId: null, accountId: null};}
}
export function parseTunnelMetrics(text) {
  const metrics = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(?:\s+\d+)?\s*$/);
    if (!match || !/^(?:cloudflared_|quic_client_|process_(?:cpu_seconds_total|resident_memory_bytes|open_fds|max_fds|start_time_seconds)$|go_(?:goroutines|threads)$)/.test(match[1]) || !Number.isFinite(Number(match[3]))) continue;
    const labels = {};
    for (const field of (match[2] || '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g)) {
      let value; try {value = JSON.parse('"' + field[2] + '"');} catch {continue;}
      const name = field[1];
      if (['conn_index', 'connection_id'].includes(name) && (/^\d{1,3}$/.test(value) || UUID.test(value))) labels[name] = value;
      if (['edge_location', 'location'].includes(name) && /^[a-zA-Z0-9-]{1,16}$/.test(value)) labels[name] = value;
      if (['code', 'status_code'].includes(name) && /^\d{3}$/.test(value)) labels[name] = value;
      if (name === 'protocol' && ['quic', 'http2', 'h2mux', 'tcp', 'udp'].includes(value)) labels[name] = value;
      if (name === 'version' && /^\d{4}\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value)) labels[name] = value;
      if (name === 'rpcName' && /^[a-zA-Z_-]{1,80}$/.test(value)) labels[name] = value;
    }
    metrics.push({name: match[1], labels, value: Number(match[3])});
    if (metrics.length === 500) break;
  }
  return metrics;
}
function total(metrics, names) {
  const values = metrics.filter(metric => names.includes(metric.name));
  return values.length ? values.reduce((sum, value) => sum + value.value, 0) : null;
}
function serviceUrl(value) {
  if (typeof value !== 'string') return '';
  if (/^http_status:[1-5]\d{2}$/.test(value) || value === 'hello_world' || value === 'bastion') return value;
  try {const url = new URL(value); if (!['http:', 'https:', 'tcp:', 'ssh:', 'rdp:', 'unix:', 'unix+tls:', 'socks5:'].includes(url.protocol)) return '[unavailable]'; url.username = url.password = url.search = url.hash = ''; return string(url.toString(), 512);} catch {return '[unavailable]';}
}
function originOptions(input) {
  const result = {};
  for (const key of ['noTLSVerify', 'http2Origin', 'disableChunkedEncoding', 'noHappyEyeballs']) if (typeof input?.[key] === 'boolean') result[key] = input[key];
  for (const key of ['connectTimeout', 'tlsTimeout', 'tcpKeepAlive', 'keepAliveConnections', 'keepAliveTimeout', 'proxyPort']) if (number(input?.[key]) !== null || (typeof input?.[key] === 'string' && /^\d+(?:\.\d+)?(?:ns|us|ms|s|m|h)?$/.test(input[key]))) result[key] = input[key];
  for (const key of ['httpHostHeader', 'originServerName']) if (typeof input?.[key] === 'string' && /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(input[key])) result[key] = input[key];
  return result;
}
export function tunnelConfiguration(input, expectedHostname) {
  const config = input?.config;
  if (!config || !Array.isArray(config.ingress)) return null;
  const routes = config.ingress.slice(0, 250).map(rule => ({hostname: string(rule.hostname), path: string(rule.path, 512), service: serviceUrl(rule.service), originRequest: originOptions(rule.originRequest)}));
  return {version: number(input.version), warpRouting: typeof config['warp-routing']?.enabled === 'boolean' ? config['warp-routing'].enabled : null, originRequest: originOptions(config.originRequest), routes, nodeRoutePresent: routes.some(rule => rule.hostname === expectedHostname && /^http:\/\/(?:127\.0\.0\.1|localhost):8788\/?$/.test(rule.service))};
}
async function local(fetchImpl, path, maximum) {
  try {
    const response = await fetchImpl(LOCAL + path, {redirect: 'manual', signal: AbortSignal.timeout(2000)});
    if (response.status >= 300 && response.status < 400) return {error: 'redirect_rejected', status: response.status};
    if (response.status === 404) return {error: 'unsupported', status: 404};
    if (!response.ok && !(path === '/ready' && response.status === 503)) return {error: 'unavailable', status: response.status};
    let text = '', size = 0;
    const decoder = new TextDecoder(), reader = response.body?.getReader();
    if (reader) while (true) {const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maximum) {await reader.cancel(); return {error: 'response_too_large', status: response.status};} text += decoder.decode(chunk.value, {stream: true});}
    text += decoder.decode();
    if (path === '/metrics') return {status: response.status, text};
    try {return {status: response.status, data: JSON.parse(text)};} catch {return {status: response.status, error: 'invalid_response'};}
  } catch {return {error: 'unavailable', status: null};}
}
const execute = async (command, args) => (await exec(command, args, {timeout: 2000, maxBuffer: 32768, windowsHide: true})).stdout;
export function createTunnelInfo({cfg, fetchImpl = fetch, run = execute, readToken = tokenFile, now = Date.now}) {
  let cached, expires = 0, pending;
  const collect = async () => {
    const expectedOrigin = cfg.NODE_REGION === 'us' ? cfg.US_ORIGIN : cfg.DE_ORIGIN;
    let hostname = ''; try {hostname = new URL(expectedOrigin).hostname;} catch {}
    const [ready, state, configuration, scrape, serviceText, versionText, identity] = await Promise.all([
      local(fetchImpl, '/ready', 4096), local(fetchImpl, '/diag/tunnel', 65536), local(fetchImpl, '/config', 262144), local(fetchImpl, '/metrics', 1048576),
      run('systemctl', ['show', 'spartan-tunnel.service', '--no-pager', '--property=ActiveState,SubState,MainPID,NRestarts,ExecMainStatus,ActiveEnterTimestamp']).catch(() => null),
      run('cloudflared', ['--version']).catch(() => null),
      readToken().then(tunnelIdentity).catch(() => ({tunnelId: null, accountId: null}))
    ]);
    const properties = {};
    for (const line of String(serviceText || '').split('\n')) {const position = line.indexOf('='); if (position > 0) properties[line.slice(0, position)] = line.slice(position + 1);}
    const numeric = key => /^\d+$/.test(properties[key] || '') ? Number(properties[key]) : null;
    const service = serviceText === null ? null : {name: 'spartan-tunnel.service', activeState: string(properties.ActiveState, 32), subState: string(properties.SubState, 32), pid: numeric('MainPID'), restarts: numeric('NRestarts'), exitCode: numeric('ExecMainStatus'), startedAt: string(properties.ActiveEnterTimestamp)};
    const metrics = scrape.error ? [] : parseTunnelMetrics(scrape.text);
    const locations = metrics.filter(metric => metric.name === 'cloudflared_tunnel_server_locations' && metric.value > 0).map(metric => ({connectionId: metric.labels.connection_id || metric.labels.conn_index || '', location: metric.labels.edge_location || metric.labels.location || ''}));
    const connections = (Array.isArray(state.data?.connections) ? state.data.connections : []).filter(connection => connection && typeof connection === 'object').slice(0, 256).map(connection => {
      const index = Number.isInteger(connection.index) && connection.index >= 0 && connection.index <= 255 ? connection.index : 0;
      const protocol = connection.protocol === 1 || connection.protocol === 'quic' ? 'quic' : connection.protocol === 0 || connection.protocol === undefined || connection.protocol === 'http2' ? 'http2' : 'unknown';
      return {index, connected: connection.isConnected === true, protocol, edgeAddress: typeof connection.edgeAddress === 'string' && isIP(connection.edgeAddress) ? connection.edgeAddress : '', location: locations.find(location => location.connectionId === String(index))?.location || ''};
    });
    const readyConnections = number(ready.data?.readyConnections);
    const metricConnections = total(metrics, ['cloudflared_tunnel_ha_connections']);
    const activeConnections = readyConnections ?? metricConnections ?? (Array.isArray(state.data?.connections) ? connections.filter(connection => connection.connected).length : null);
    const readiness = ready.status === 200 ? true : ready.status === 503 ? false : null;
    const status = readiness === true ? 'connected' : readiness === false ? 'disconnected' : activeConnections > 0 ? 'connected' : service?.activeState === 'inactive' || service?.activeState === 'failed' ? 'disconnected' : 'unknown';
    const version = String(versionText || '').match(/cloudflared version (\d{4}\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)/)?.[1] || metrics.find(metric => metric.labels.version)?.labels.version || null;
    const start = total(metrics, ['process_start_time_seconds']);
    const processUptimeSeconds = start !== null && start > 0 && start * 1000 <= now() ? Math.floor(now() / 1000 - start) : null;
    const tunnelId = uuid(state.data?.tunnelID) || identity.tunnelId;
    const connectorId = uuid(state.data?.connectorID) || uuid(ready.data?.connectorId);
    const routes = configuration.error ? null : tunnelConfiguration(configuration.data, hostname);
    const availability = {readiness: ready.error || null, connections: state.error || null, configuration: configuration.error || (routes ? null : 'invalid_response'), metrics: scrape.error || null, service: service ? null : 'unavailable', version: version ? null : 'unavailable'};
    return {region: cfg.NODE_REGION, hostname, tunnelId, accountId: identity.accountId, connectorId, status, ready: readiness, activeConnections, service, version, processUptimeSeconds, identityMatchesFile: tunnelId && identity.tunnelId ? tunnelId === identity.tunnelId : null, connections, edgeLocations: locations, configuration: routes, counters: {totalRequests: total(metrics, ['cloudflared_tunnel_total_requests']), requestErrors: total(metrics, ['cloudflared_tunnel_request_errors']), concurrentRequests: total(metrics, ['cloudflared_tunnel_concurrent_requests_per_tunnel']), registrationFailures: total(metrics, ['cloudflared_tunnel_tunnel_register_fail']), receivedBytes: total(metrics, ['quic_client_receive_bytes', 'quic_client_received_bytes']), sentBytes: total(metrics, ['quic_client_sent_bytes']), processMemoryBytes: total(metrics, ['process_resident_memory_bytes']), processCpuSeconds: total(metrics, ['process_cpu_seconds_total'])}, metrics, availability, sampledAt: new Date(now()).toISOString()};
  };
  return async () => {
    if (cached && now() < expires) return cached;
    if (!pending) pending = collect().then(result => {cached = result; expires = now() + 5000; return result;}).finally(() => {pending = null;});
    return pending;
  };
}
