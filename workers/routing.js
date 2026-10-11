import {PROBE_PATH, domainProbe} from './domain-probe.js';
import {ID, json, region, visitorIp} from './shared.js';
import {routingControl} from './routing-registry.js';
import {readRoute, resolveHostname} from './store.js';
import {monitorDomains} from './domains-d1.js';
import {sensitivePath} from './security.js';
import {statusPage} from './status-page.js';
import {resolveInstanceHostname} from './instance-hostnames.js';

// Every page, script and image of a tenant passes through here, so the D1 lookups behind
// it (hostname -> tenant, tenant -> route) are cached per isolate for a few seconds. A
// status change (suspend, terminate) therefore reaches visitors after a short delay;
// ROUTE_CACHE_SECONDS bounds that delay; unset or 0 disables the cache. npm run configure sets 10.
const lookups = new WeakMap();
async function cached(env, key, load) {
  const seconds = Number(env.ROUTE_CACHE_SECONDS || 0);
  if (!(seconds > 0)) return load();
  let cache = lookups.get(env);
  if (!cache) { cache = new Map(); lookups.set(env, cache); }
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  if (cache.size > 5000) cache.clear();
  // Misses are kept briefly too, so a burst against an unknown hostname costs one query.
  cache.set(key, {value, expires: Date.now() + (value ? seconds : Math.min(seconds, 5)) * 1000});
  return value;
}
// With D1 read replication enabled, read from the nearest replica; otherwise this is the
// primary database exactly as before.
const reader = env => (typeof env.DB?.withSession === 'function' ? {...env, DB: env.DB.withSession('first-unconstrained')} : env);

export default {
  async scheduled(event, env) {
    // D1 has no alarms, so the cron trigger drives the certificate sweep.
    await monitorDomains(env);
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const pageAsset = ['GET', 'HEAD'].includes(request.method) && url.pathname === '/__spartan_assets/regions.jpeg';
    const asset = () => env.ASSETS ? env.ASSETS.fetch(request) : json({error: 'not_found'}, 404);
    const missing = async () => {
      if (pageAsset) return asset();
      const browser = ['GET', 'HEAD'].includes(request.method) && (['/', '/__routing_status'].includes(url.pathname) || (request.headers.get('accept') || '').includes('text/html'));
      return browser ? statusPage(request, env, url.pathname === '/__routing_status', 404) : json({error: 'not_found'}, 404);
    };
    try {
      if (url.pathname === PROBE_PATH) return await domainProbe(request, env);
      const controlHost = url.hostname === env.BASE_DOMAIN || url.hostname === env.ROUTING_API_HOSTNAME || url.hostname.endsWith('.workers.dev');
      if (controlHost && pageAsset) return await asset();
      if (controlHost && ['GET', 'HEAD'].includes(request.method) && ['/', '/__routing_status'].includes(url.pathname)) return await statusPage(request, env, url.pathname === '/__routing_status');
      if (controlHost && url.pathname.startsWith('/v1/routing/')) {
        if (url.protocol !== 'https:') return json({error: 'https_required'}, 400);
        // Deployed from the unconfigured placeholder, or with the binding dropped. Every
        // other failure here reads as a bad origin, so name this one.
        if (!env.DB) return json({error: 'database_binding_missing'}, 503);
        return await routingControl(request, env);
      }
      if (sensitivePath(url.pathname)) return json({error: 'not_found'}, 404);
      let id;
      if (url.hostname.endsWith(`.${env.BASE_DOMAIN}`)) id = url.hostname.slice(0, -env.BASE_DOMAIN.length - 1);
      else {
        if (!env.DB) return await missing();
        const read = reader(env);
        id = await cached(env, `host:${url.hostname}`, async () => await resolveInstanceHostname(read, url.hostname) || await resolveHostname(read, url.hostname));
        if (!id) return await missing();
      }
      if (!ID.test(id)) return await missing();
      if (!env.DB) return json({error: 'database_binding_missing'}, 503);
      if (url.protocol !== 'https:') { url.protocol = 'https:'; return Response.redirect(url.toString(), 308); }
      const record = await cached(env, `route:${id}`, () => readRoute(reader(env), id));
      if (!record) return await missing();
      if (['suspended', 'suspending'].includes(record.status)) return json({error: 'service_suspended'}, 403);
      if (['terminated', 'terminating'].includes(record.status)) return json({error: 'service_terminated'}, 410);
      if (record.status !== 'ready') return json({error: 'provisioning'}, 503);
      const ip = visitorIp(request.headers);
      if (!ip) return json({error: 'client_ip_unavailable'}, 503);
      const location = env.DATABASE_MODE === 'us-central' && record.primary === 'us'
        ? region(request.cf?.country || 'US')
        : record.primary === 'de' ? 'de' : 'us';
      const origin = location === 'us' ? env.US_ORIGIN : env.DE_ORIGIN;
      const target = new URL(origin);
      target.pathname = `/tenant/${id}${url.pathname}`;
      target.search = url.search;
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) {
        if (key.startsWith('x-spartan-') || key.startsWith('x-forwarded-') || ['forwarded', 'host', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-pseudo-ipv4', 'cf-access-client-id', 'cf-access-client-secret'].includes(key)) headers.delete(key);
      }
      headers.set('x-spartan-origin', env.ORIGIN_SECRET);
      headers.set('x-spartan-host', url.hostname);
      headers.set('x-spartan-custom-domain', url.hostname === `${id}.${env.BASE_DOMAIN}` ? '0' : '1');
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-spartan-client-ip', ip);
      headers.set('x-real-ip', ip);
      headers.set('x-forwarded-for', ip);
      return await fetch(new Request(target, {method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual', duplex: 'half'}));
    } catch {
      return json({error: 'origin_unavailable'}, 503);
    }
  }
};
