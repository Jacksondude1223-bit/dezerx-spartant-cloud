import {hmac} from './crypto.mjs';
import {ApiError} from './store.mjs';
export const REGIONS = {us: 'United States', de: 'Germany'};
export function configurationIssues(env) {
  const issues = [];
  for (const name of ['ADMIN_API_SECRET', 'ORIGIN_SECRET']) {
    const value = env[name];
    if (typeof value !== 'string' || value.length < 32 || /[\x00-\x20\x7f]/.test(value)) issues.push({name, reason: 'Use the existing node secret, at least 32 characters, without spaces or line breaks.'});
  }
  if (!/^[a-f0-9]{64}$/.test(env.DASHBOARD_DATA_KEY || '')) issues.push({name: 'DASHBOARD_DATA_KEY', reason: 'Must be exactly 64 lowercase hexadecimal characters (0-9 and a-f), without quotes or spaces. Preserve the key after setup.'});
  if (env.DASHBOARD_TOTP_SECRET && !/^[A-Z2-7]{16,128}$/.test(env.DASHBOARD_TOTP_SECRET)) issues.push({name: 'DASHBOARD_TOTP_SECRET', reason: 'Must be 16 to 128 uppercase Base32 characters (A-Z and 2-7). Leave it unset if two-factor authentication is not configured.'});
  return issues;
}
export function configuration(env) {
  const invalidSettings = configurationIssues(env);
  if (invalidSettings.length) {const error = new ApiError(503, 'dashboard_configuration_required'); error.invalidSettings = invalidSettings; throw error;}
  const origins = {};
  for (const region of Object.keys(REGIONS)) {
    const url = new URL(env[region.toUpperCase() + '_ORIGIN']);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new ApiError(503, 'invalid_node_origin');
    origins[region] = url.origin;
  }
  const baseDomain = env.BASE_DOMAIN || 'load.dezerx.cloud';
  const router = new URL(env.ROUTING_API_URL || 'https://' + baseDomain);
  if (router.protocol !== 'https:' || router.username || router.password || router.search || router.hash || !['', '/'].includes(router.pathname)) throw new ApiError(503, 'invalid_router_origin');
  const hours = Number(env.DASHBOARD_SESSION_HOURS || 12);
  const memory = Number(env.DASHBOARD_MIN_FREE_MEMORY_MB || 1024) * 1024 ** 2;
  const disk = Number(env.DASHBOARD_MIN_FREE_DISK_GB || 5) * 1024 ** 3;
  if (!Number.isFinite(hours) || hours < 1 || hours > 168 || !Number.isFinite(memory) || memory < 0 || !Number.isFinite(disk) || disk < 0) throw new ApiError(503, 'invalid_dashboard_limits');
  return {origins, router: router.origin, baseDomain, instanceDomain: env.INSTANCE_DOMAIN || 'dezerx.cloud', hours, memory, disk};
}
export function clients(env, fetchImpl = fetch) {
  const config = configuration(env);
  const call = async (origin, path, payload, secret, {method = 'POST', raw = false, timeout = 25000} = {}) => {
    const body = method === 'GET' ? '' : JSON.stringify(payload);
    const stamp = String(Date.now());
    let response;
    try {
      response = await fetchImpl(origin + path, {method, headers: {'content-type': 'application/json', 'x-spartan-timestamp': stamp, 'x-spartan-signature': await hmac(secret, `${stamp}\n${method}\n${path}\n${body}`), 'user-agent': 'spartan-dashboard-worker'}, body: method === 'GET' ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(timeout)});
    } catch {throw new ApiError(504, 'node_timeout');}
    if (response.status >= 300 && response.status < 400) throw new ApiError(502, 'unexpected_origin_redirect');
    if (raw && response.ok) return response;
    const text = await response.text().catch(() => '');
    let data;
    try {data = JSON.parse(text);} catch {
      const error = new ApiError(502, response.status === 403 ? 'blocked_by_cloudflare' : 'invalid_node_response');
      error.data = {upstream: new URL(origin).host, upstreamStatus: response.status, cloudflareError: text.match(/Error (?:code:? )?(\d{3,4})/i)?.[1] || null};
      console.error(JSON.stringify({event: 'invalid_upstream_response', path, ...error.data}));
      throw error;
    }
    if (!response.ok) {
      const error = new ApiError(response.status === 524 ? 504 : response.status, String(data.error || 'operation_failed').slice(0, 80));
      error.data = data; throw error;
    }
    return data;
  };
  const node = (region, operation, payload = {}, options) => {
    if (!config.origins[region]) throw new ApiError(404, 'unknown_node');
    return call(config.origins[region], '/admin/' + operation, payload, env.ADMIN_API_SECRET, options);
  };
  const control = (region, operation, payload) => call(config.origins[region], '/control/' + operation, payload, env.NODE_CONTROL_SECRET || env.ORIGIN_SECRET);
  const routing = (operation, payload = {}, options) => call(config.router, '/v1/routing/' + operation, payload, env.ROUTING_CONTROL_SECRET || env.ORIGIN_SECRET, options);
  const overview = async () => ({nodes: await Promise.all(Object.keys(REGIONS).map(async region => {
    const host = new URL(config.origins[region]).host;
    try {
      const start = Date.now();
      const [data, ping] = await Promise.all([node(region, 'overview'), node(region, 'ping').then(() => Date.now() - start).catch(() => null)]);
      return {region, label: REGIONS[region], endpoint: host, host, ok: true, ...data, latencyMs: ping};
    } catch (error) {return {region, label: REGIONS[region], endpoint: host, host, ok: false, error: error.message};}
  })), sampledAt: new Date().toISOString()});
  return {config, node, control, routing, overview};
}
