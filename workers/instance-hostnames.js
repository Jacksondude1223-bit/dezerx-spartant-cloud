import {json} from './shared.js';
import {readRoute} from './store.js';

async function cloudflareCall(endpoint, headers, phase, body) {
  let response;
  try {response = await fetch(endpoint, {method: body ? 'PUT' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(8000)});}
  catch {throw Object.assign(new Error('cloudflare_api_timeout'), {phase, retryable: true});}
  const data = await response.json().catch(() => null);
  const cloudflareCodes = (Array.isArray(data?.errors) ? data.errors : []).map(item => item?.code).filter(Number.isSafeInteger).slice(0, 5);
  if (!response.ok || data?.success !== true) {
    const reason = [401, 403].includes(response.status) ? 'cloudflare_access_denied' : response.status === 429 ? 'cloudflare_rate_limited' : !data ? 'cloudflare_invalid_response' : 'cloudflare_request_rejected';
    throw Object.assign(new Error(reason), {phase, upstream: 'api.cloudflare.com', upstreamStatus: response.status, cloudflareCodes, retryable: response.status === 429 || response.status >= 500});
  }
  return data.result;
}

export async function allocateHostname(env, id) {
  const tenant = await readRoute(env, id);
  if (!tenant || tenant.status === 'terminated') return json({error: 'tenant_unavailable'}, 409);
  const domain = env.INSTANCE_DOMAIN || env.SAAS_ZONE_DOMAIN;
  if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) || domain !== env.SAAS_ZONE_DOMAIN) return json({error: 'instance_domain_configuration_required'}, 503);
  if (!env.CF_INSTANCE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ZONE_ID || !env.ROUTING_WORKER_NAME) return json({error: 'instance_domain_configuration_required'}, 503);
  let record = await env.DB.prepare('SELECT hostname, tenantId, status FROM instance_hostnames WHERE tenantId = ?').bind(id).first();
  for (let attempt = 0; !record && attempt < 64; attempt++) {
    const numbers = crypto.getRandomValues(new Uint32Array(1));
    if (numbers[0] >= Math.floor(4294967296 / 9000) * 9000) continue;
    const name = `instance-${1000 + numbers[0] % 9000}.${domain}`;
    await env.DB.prepare("INSERT INTO instance_hostnames (hostname, tenantId, status) VALUES (?, ?, 'pending') ON CONFLICT DO NOTHING").bind(name, id).run();
    record = await env.DB.prepare('SELECT hostname, tenantId, status FROM instance_hostnames WHERE tenantId = ?').bind(id).first();
  }
  if (!record) return json({error: 'instance_hostname_capacity'}, 409);
  if (record.status !== 'active') {
    try {
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
      const headers = {authorization: `Bearer ${env.CF_INSTANCE_API_TOKEN}`, 'content-type': 'application/json'};
      const existing = await cloudflareCall(`${endpoint}?hostname=${encodeURIComponent(record.hostname)}`, headers, 'list');
      if (!Array.isArray(existing)) throw Object.assign(new Error('cloudflare_invalid_response'), {phase: 'list'});
      const attached = existing.filter(item => item.hostname === record.hostname);
      if (attached.some(item => item.service !== env.ROUTING_WORKER_NAME || item.zone_id !== env.CLOUDFLARE_ZONE_ID)) return json({error: 'instance_hostname_conflict', hostname: record.hostname}, 409);
      if (!attached.some(item => item.enabled !== false)) {
        const result = await cloudflareCall(endpoint, headers, 'attach', {hostname: record.hostname, service: env.ROUTING_WORKER_NAME, zone_id: env.CLOUDFLARE_ZONE_ID, enabled: true});
        if (result?.hostname !== record.hostname || result?.service !== env.ROUTING_WORKER_NAME || result?.zone_id !== env.CLOUDFLARE_ZONE_ID || result.enabled === false) throw Object.assign(new Error('cloudflare_invalid_response'), {phase: 'attach'});
      }
      await env.DB.prepare("UPDATE instance_hostnames SET status = 'active' WHERE tenantId = ?").bind(id).run();
      record.status = 'active';
    } catch (error) {
      const reason = ['cloudflare_access_denied', 'cloudflare_rate_limited', 'cloudflare_invalid_response', 'cloudflare_request_rejected', 'cloudflare_api_timeout'].includes(error.message) ? error.message : 'hostname_database_failed';
      const details = {reason, phase: error.phase || 'database', upstream: error.upstream, upstreamStatus: error.upstreamStatus, cloudflareCodes: error.cloudflareCodes || [], retryable: error.retryable === true};
      console.warn(JSON.stringify({event: 'instance_hostname_setup_failed', id, hostname: record.hostname, ...details}));
      return json({error: 'instance_hostname_setup_failed', hostname: record.hostname, ...details}, 503);
    }
  }
  return json({id, hostname: record.hostname, url: `https://${record.hostname}`, status: record.status, ssl: 'cloudflare_managed', certificateMayBePending: true});
}

export async function resolveInstanceHostname(env, name) {
  return (await env.DB.prepare("SELECT tenantId FROM instance_hostnames WHERE hostname = ? AND status = 'active'").bind(name).first())?.tenantId || null;
}
