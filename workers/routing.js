import {ID, json, region} from './shared.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.hostname.endsWith(`.${env.BASE_DOMAIN}`)) return json({error: 'not_found'}, 404);
    const id = url.hostname.slice(0, -env.BASE_DOMAIN.length - 1);
    if (!ID.test(id)) return json({error: 'not_found'}, 404);
    if (url.protocol !== 'https:') { url.protocol = 'https:'; return Response.redirect(url.toString(), 308); }
    try {
      const state = await env.TENANTS.getByName(id).fetch('https://tenant/status');
      if (!state.ok) return json({error: 'not_found'}, 404);
      const record = await state.json();
      if (record.status !== 'ready') return json({error: 'provisioning'}, 503);
      const selected = region(request.cf?.country || 'US');
      const origin = selected === 'us' ? env.US_ORIGIN : env.DE_ORIGIN;
      const target = new URL(origin);
      target.pathname = `/tenant/${id}${url.pathname}`;
      target.search = url.search;
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) {
        if (key.startsWith('x-spartan-') || key.startsWith('x-forwarded-') || ['forwarded', 'host', 'cf-access-client-id', 'cf-access-client-secret'].includes(key)) headers.delete(key);
      }
      headers.set('x-spartan-origin', env.ORIGIN_SECRET);
      headers.set('x-spartan-host', url.hostname);
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '');
      return await fetch(new Request(target, {method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual', duplex: 'half'}));
    } catch {
      return json({error: 'origin_unavailable'}, 503);
    }
  }
};
