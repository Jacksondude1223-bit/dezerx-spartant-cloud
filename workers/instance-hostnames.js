import {json} from './shared.js';
import {readRoute} from './store.js';

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
      const check = await fetch(`${endpoint}?hostname=${encodeURIComponent(record.hostname)}`, {headers, signal: AbortSignal.timeout(8000)});
      const existing = await check.json();
      if (!check.ok || !existing.success || !Array.isArray(existing.result)) throw new Error('cloudflare_failed');
      if (existing.result.some(item => item.hostname === record.hostname && (item.service !== env.ROUTING_WORKER_NAME || item.zone_id !== env.CLOUDFLARE_ZONE_ID))) return json({error: 'instance_hostname_conflict'}, 409);
      const response = await fetch(endpoint, {method: 'PUT', headers, body: JSON.stringify({hostname: record.hostname, service: env.ROUTING_WORKER_NAME, zone_id: env.CLOUDFLARE_ZONE_ID}), signal: AbortSignal.timeout(8000)});
      const result = await response.json();
      if (!response.ok || !result.success || result.result?.hostname !== record.hostname || result.result?.service !== env.ROUTING_WORKER_NAME) throw new Error('cloudflare_failed');
      await env.DB.prepare("UPDATE instance_hostnames SET status = 'active' WHERE tenantId = ?").bind(id).run();
      record.status = 'active';
    } catch { return json({error: 'instance_hostname_setup_failed', hostname: record.hostname, retryable: true}, 503); }
  }
  return json({id, hostname: record.hostname, url: `https://${record.hostname}`, status: record.status, ssl: 'cloudflare_managed', certificateMayBePending: true});
}

export async function resolveInstanceHostname(env, name) {
  return (await env.DB.prepare("SELECT tenantId FROM instance_hostnames WHERE hostname = ? AND status = 'active'").bind(name).first())?.tenantId || null;
}
