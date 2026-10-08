import {ID, REGIONS, json, verify} from './shared.js';
import {readRoute, registerRoute} from './store.js';
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
  return json({error: 'not_found'}, 404);
}
