import {ID, json} from './shared.js';

export function hostname(value, env) {
  if (typeof value !== 'string') throw new Error('invalid_hostname');
  const name = value.toLowerCase().replace(/\.$/, '');
  if (name.length > 200 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new Error('invalid_hostname');
  for (const blocked of [env.BASE_DOMAIN, env.SAAS_ZONE_DOMAIN, new URL(env.US_ORIGIN).hostname, new URL(env.DE_ORIGIN).hostname].filter(Boolean)) {
    if (name === blocked || name.endsWith(`.${blocked}`)) throw new Error('reserved_hostname');
  }
  return name;
}
async function api(env, method, suffix, body) {
  if (!env.CF_SAAS_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) throw new Error('saas_configuration_required');
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames${suffix}`, {method, headers: {authorization: `Bearer ${env.CF_SAAS_API_TOKEN}`, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000)});
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`cloudflare_${response.status}`);
  return result.result;
}
async function dns(name, type) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const response = await fetch(url, {headers: {accept: 'application/dns-json'}, signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('dns_unavailable');
  const data = await response.json();
  if (data.Status !== 0 || data.CD === true) return [];
  return data.Answer || [];
}
function txt(value) {
  const chunks = value.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks) return value;
  try { return chunks.map(chunk => JSON.parse(chunk)).join(''); } catch { return ''; }
}
export class Domains {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.tail = Promise.resolve(); }
  async fetch(request) {
    const result = this.tail.then(async () => {
      try { return await this.handle(request); }
      catch (error) {
        const client = ['invalid_hostname', 'reserved_hostname', 'invalid_tenant'].includes(error.message);
        return json({error: client ? error.message : 'domain_operation_failed'}, client ? 400 : 503);
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  public(record) {
    return {hostname: record.hostname, tenantId: record.tenantId, status: record.status, cname: {type: 'CNAME', name: record.hostname, target: this.env.SAAS_CNAME_TARGET, proxied: false}, ownership: {type: 'TXT', name: `_spartan-verification.${record.hostname}`, value: record.token}, certificateStatus: record.certificateStatus, cloudflareOwnership: record.cloudflareOwnership, certificateValidation: record.certificateValidation};
  }
  async handle(request) {
    const input = await request.json();
    const name = hostname(input.hostname, this.env);
    const key = `domain:${name}`;
    const record = await this.ctx.storage.get(key);
    const action = new URL(request.url).pathname;
    if (action === '/resolve') {
      if (!record || record.status !== 'active') return json({error: 'not_found'}, 404);
      return json({id: record.tenantId});
    }
    if (!ID.test(input.tenantId || '')) throw new Error('invalid_tenant');
    if (record && record.tenantId !== input.tenantId) return json({error: 'hostname_conflict'}, 409);
    const tenant = await this.env.TENANTS.getByName(input.tenantId).fetch('https://tenant/status');
    if (!tenant.ok || (await tenant.json()).status !== 'ready') return json({error: 'tenant_not_ready'}, 409);
    if (action === '/reserve') {
      if (record) return json(this.public(record));
      const reservations = await this.ctx.storage.list({prefix: 'domain:'});
      if (reservations.size >= 100) return json({error: 'free_hostname_limit'}, 409);
      const value = {hostname: name, tenantId: input.tenantId, token: crypto.randomUUID(), status: 'pending_ownership'};
      await this.ctx.storage.put(key, value);
      return json(this.public(value), 201);
    }
    if (!record) return json({error: 'not_found'}, 404);
    if (action === '/status') return json(this.public(record));
    if (action === '/delete') {
      await this.ctx.storage.put(key, {...record, status: 'deleting'});
      if (record.cloudflareId) await api(this.env, 'DELETE', `/${record.cloudflareId}`);
      await this.ctx.storage.delete(key);
      return json({deleted: true});
    }
    if (action !== '/verify') return json({error: 'not_found'}, 404);
    const proof = await dns(`_spartan-verification.${name}`, 'TXT');
    if (!proof.some(answer => answer.type === 16 && answer.name.toLowerCase().replace(/\.$/, '') === `_spartan-verification.${name}` && txt(answer.data) === record.token)) {
      await this.ctx.storage.put(key, {...record, status: 'pending_ownership'});
      return json({error: 'ownership_not_verified', ...this.public({...record, status: 'pending_ownership'})}, 409);
    }
    if (!record.cloudflareId) {
      const existing = await api(this.env, 'GET', `?hostname=${encodeURIComponent(name)}`);
      const found = existing.find(value => value.hostname === name);
      if (found && !record.createAttempted) return json({error: 'hostname_already_registered'}, 409);
      if (found) record.cloudflareId = found.id;
      else {
        const quota = await api(this.env, 'GET', '/quota');
        if (!Number.isSafeInteger(quota.used) || quota.used < 0) throw new Error('unknown_quota');
        const used = Math.max(quota.used, await this.ctx.storage.get('budgetUsed') || 0);
        if (!record.slotReserved) {
          if (used >= 100) return json({error: 'free_hostname_limit'}, 409);
          await this.ctx.storage.put('budgetUsed', used + 1);
          record.slotReserved = true;
        } else if (quota.used >= 100) return json({error: 'free_hostname_limit'}, 409);
        record.createAttempted = true;
        await this.ctx.storage.put(key, record);
        const created = await api(this.env, 'POST', '', {hostname: name, ssl: {method: 'txt', type: 'dv', settings: {min_tls_version: '1.2'}}});
        record.cloudflareId = created.id;
      }
      await this.ctx.storage.put(key, record);
    }
    const remote = await api(this.env, 'GET', `/${record.cloudflareId}`);
    const cnames = await dns(name, 'CNAME');
    const pointed = cnames.some(answer => answer.type === 5 && answer.name.toLowerCase().replace(/\.$/, '') === name && answer.data.toLowerCase().replace(/\.$/, '') === this.env.SAAS_CNAME_TARGET);
    const active = remote.hostname === name && remote.status === 'active' && remote.ssl?.status === 'active' && pointed;
    const value = {...record, certificateStatus: remote.ssl?.status, cloudflareOwnership: remote.ownership_verification, certificateValidation: remote.ssl?.validation_records, status: active ? 'active' : 'pending_certificate'};
    await this.ctx.storage.put(key, value);
    if (!active) await this.ctx.storage.setAlarm(Date.now() + 60000);
    return json(this.public(value));
  }
  async alarm() {
    const records = await this.ctx.storage.list({prefix: 'domain:'});
    for (const record of records.values()) {
      if (record.status !== 'pending_certificate' || !record.cloudflareId) continue;
      await this.fetch(new Request('https://domains/verify', {method: 'POST', body: JSON.stringify({hostname: record.hostname, tenantId: record.tenantId})}));
    }
    const remaining = await this.ctx.storage.list({prefix: 'domain:'});
    if ([...remaining.values()].some(record => record.status === 'pending_certificate')) await this.ctx.storage.setAlarm(Date.now() + 300000);
  }
}
