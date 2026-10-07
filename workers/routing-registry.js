import {ID, REGIONS, json, verify} from './shared.js';
import {readRoute, registerRoute, importDomain} from './store.js';
import {domainAction} from './domains-d1.js';

const statuses = new Set(['pending', 'ready', 'suspended', 'terminated']);
const field = /^[A-Za-z0-9_-]{1,100}$/;
export function validRoute(input) {
  return !!input && typeof input === 'object' && !Array.isArray(input)
    && !['id', 'serviceId', 'customerId', 'primary', 'status'].some(key => typeof input[key] !== 'string')
    && ID.test(input.id) && field.test(input.serviceId) && field.test(input.customerId)
    && REGIONS.has(input.primary) && statuses.has(input.status)
    && Number.isSafeInteger(input.lifecycleVersion) && input.lifecycleVersion >= 0;
}

export class RoutingTenant {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;
      const previous = await this.ctx.storage.get('route');
      if (path === '/status' && request.method === 'GET') return previous ? json(previous) : json({error: 'not_found'}, 404);
      if (path !== '/register' || request.method !== 'POST') return json({error: 'not_found'}, 404);
      let input;
      try { input = await request.json(); } catch { return json({error: 'invalid_json'}, 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || ['id', 'serviceId', 'customerId', 'primary', 'status'].some(key => typeof input[key] !== 'string') || !ID.test(input.id || '') || !field.test(input.serviceId || '') || !field.test(input.customerId || '') || !REGIONS.has(input.primary) || !statuses.has(input.status) || !Number.isSafeInteger(input.lifecycleVersion) || input.lifecycleVersion < 0) return json({error: 'invalid_route'}, 400);
      const record = {id: input.id, serviceId: input.serviceId, customerId: input.customerId, primary: input.primary, status: input.status, lifecycleVersion: input.lifecycleVersion};
      if (previous) {
        if (['id', 'serviceId', 'customerId', 'primary'].some(key => previous[key] !== record[key])) return json({error: 'service_conflict'}, 409);
        if (record.lifecycleVersion < previous.lifecycleVersion || record.lifecycleVersion === previous.lifecycleVersion && record.status !== previous.status) return json({error: 'stale_operation'}, 409);
        if (previous.status === 'terminated' && record.status !== 'terminated') return json({error: 'service_terminated'}, 409);
      }
      await this.ctx.storage.put('route', record);
      return json(record, previous ? 200 : 201);
    });
  }
}

async function bodyText(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) { await reader.cancel(); throw new Error('body_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function routingControl(request, env) {
  let body;
  try { body = await bodyText(request); } catch { return json({error: 'body_too_large'}, 413); }
  if (!await verify(request, body, env.ROUTING_CONTROL_SECRET)) return json({error: 'unauthorized'}, 401);
  const path = new URL(request.url).pathname;
  let input;
  try { input = body ? JSON.parse(body) : {}; } catch { return json({error: 'invalid_json'}, 400); }
  if (path === '/v1/routing/instances' && request.method === 'POST') {
    const record = input && typeof input === 'object' && !Array.isArray(input)
      ? {...input, status: input.status === 'active' ? 'ready' : input.status} : null;
    if (!validRoute(record)) return json({error: 'invalid_route'}, 400);
    const result = await registerRoute(env, {id: record.id, serviceId: record.serviceId, customerId: record.customerId, primary: record.primary, status: record.status, lifecycleVersion: record.lifecycleVersion});
    if (result.error) return json({error: result.error}, 409);
    return json(result.record, result.created ? 201 : 200);
  }
  const instance = path.match(/^\/v1\/routing\/instances\/(t-[a-f0-9]{24})$/);
  if (instance && request.method === 'GET') {
    const record = await readRoute(env, instance[1]);
    return record ? json(record) : json({error: 'not_found'}, 404);
  }
  const domain = path.match(/^\/v1\/routing\/instances\/(t-[a-f0-9]{24})\/domains\/(reserve|verify|status|delete)$/);
  if (domain && request.method === 'POST') {
    if (!input || typeof input.hostname !== 'string') return json({error: 'invalid_hostname'}, 400);
    return domainAction(env, domain[2], {hostname: input.hostname, tenantId: domain[1]});
  }
  // One-shot migration: copies custom-domain registrations out of the legacy Durable
  // Object into D1. Idempotent, so it can be replayed. Routing records cannot be migrated
  // this way because a Durable Object namespace cannot be enumerated by name - re-register
  // those from the master website instead.
  if (path === '/v1/routing/migrate/domains' && request.method === 'POST') {
    if (!env.DOMAINS) return json({error: 'legacy_namespace_unavailable'}, 409);
    const response = await env.DOMAINS.getByName('registry').fetch('https://domains/export', {method: 'POST', body: '{}'});
    if (!response.ok) return json({error: 'legacy_export_failed'}, 503);
    const {domains} = await response.json();
    let imported = 0;
    for (const record of domains || []) if (record?.hostname && record?.tenantId && await importDomain(env, record)) imported++;
    return json({found: (domains || []).length, imported});
  }
  return json({error: 'not_found'}, 404);
}
