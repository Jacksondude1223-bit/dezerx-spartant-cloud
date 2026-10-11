import {hmac} from './crypto.mjs';
import {ApiError} from './store.mjs';
export const REGIONS = {us: 'United States', de: 'Germany'};
export function configuration(env) {
  for (const key of ['ADMIN_API_SECRET', 'ORIGIN_SECRET']) if (typeof env[key] !== 'string' || env[key].length < 32 || /[\x00-\x20\x7f]/.test(env[key])) throw new ApiError(503, 'dashboard_configuration_required');
  if (env.ADMIN_API_SECRET === env.ORIGIN_SECRET || !/^[a-f0-9]{64}$/.test(env.DASHBOARD_DATA_KEY || '') || !/^[a-zA-Z0-9_.@-]{1,64}$/.test(env.DASHBOARD_USER || '') || !/^pbkdf2\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/.test(env.DASHBOARD_PASSWORD_HASH || '')) throw new ApiError(503, 'dashboard_configuration_required');
  if (env.DASHBOARD_TOTP_SECRET && !/^[A-Z2-7]{16,128}$/.test(env.DASHBOARD_TOTP_SECRET)) throw new ApiError(503, 'dashboard_configuration_required');
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
    let data;
    try {data = await response.json();} catch {throw new ApiError(502, response.status === 403 ? 'blocked_by_cloudflare' : 'invalid_node_response');}
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
