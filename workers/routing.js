import {ID, json, region, visitorIp} from './shared.js';
import {routingControl} from './routing-registry.js';
import {statusPage} from './status-page.js';
export {RoutingTenant} from './routing-registry.js';
export {Domains} from './domains.js';

export default {
  async scheduled(event, env) {
    const response = await env.DOMAINS.getByName('registry').fetch('https://domains/monitor', {method: 'POST', body: '{}'});
    if (!response.ok) throw new Error('domain_monitor_failed');
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const missing = async () => {
      const browser = ['GET', 'HEAD'].includes(request.method) && (['/', '/__routing_status'].includes(url.pathname) || (request.headers.get('accept') || '').includes('text/html'));
      return browser ? statusPage(request, env, url.pathname === '/__routing_status', 404) : json({error: 'not_found'}, 404);
    };
    try {
      const controlHost = url.hostname === env.BASE_DOMAIN || url.hostname === env.ROUTING_API_HOSTNAME || url.hostname.endsWith('.workers.dev');
      if (controlHost && ['GET', 'HEAD'].includes(request.method) && ['/', '/__routing_status'].includes(url.pathname)) return await statusPage(request, env, url.pathname === '/__routing_status');
      if (controlHost && url.pathname.startsWith('/v1/routing/')) {
        if (url.protocol !== 'https:') return json({error: 'https_required'}, 400);
        return await routingControl(request, env);
      }
      let id;
      if (url.hostname.endsWith(`.${env.BASE_DOMAIN}`)) id = url.hostname.slice(0, -env.BASE_DOMAIN.length - 1);
      else {
        if (!env.DOMAINS) return await missing();
        const mapping = await env.DOMAINS.getByName('registry').fetch('https://domains/resolve', {method: 'POST', body: JSON.stringify({hostname: url.hostname})});
        if (!mapping.ok) return await missing();
        id = (await mapping.json()).id;
      }
      if (!ID.test(id)) return await missing();
      if (url.protocol !== 'https:') { url.protocol = 'https:'; return Response.redirect(url.toString(), 308); }
      const state = await env.TENANTS.getByName(id).fetch('https://tenant/status');
      if (!state.ok) return await missing();
      const record = await state.json();
      if (['suspended', 'suspending'].includes(record.status)) return json({error: 'service_suspended'}, 403);
      if (['terminated', 'terminating'].includes(record.status)) return json({error: 'service_terminated'}, 410);
      if (record.status !== 'ready') return json({error: 'provisioning'}, 503);
      const ip = visitorIp(request.headers);
      if (!ip) return json({error: 'client_ip_unavailable'}, 503);
      const selected = region(request.cf?.country || 'US');
      const origin = selected === 'us' ? env.US_ORIGIN : env.DE_ORIGIN;
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
