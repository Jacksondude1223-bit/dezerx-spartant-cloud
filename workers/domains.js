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
  limit() {
    const limit = Number(this.env.MAX_CUSTOM_HOSTNAMES || 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_hostname_limit');
    return limit;
  }
  async schedule() {
    const records = await this.ctx.storage.list({prefix: 'domain:'});
    const monitored = [...records.values()].filter(record => record.status !== 'deleting');
    if (monitored.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...monitored.map(record => record.nextCheckAt || 0))));
    else if (this.ctx.storage.deleteAlarm) await this.ctx.storage.deleteAlarm();
  }
  public(record) {
    return {hostname: record.hostname, tenantId: record.tenantId, status: record.status, cname: {type: 'CNAME', name: record.hostname, target: this.env.SAAS_CNAME_TARGET, proxied: false}, ownership: {type: 'TXT', name: `_spartan-verification.${record.hostname}`, value: record.token}, certificateStatus: record.certificateStatus, cloudflareOwnership: record.cloudflareOwnership, certificateValidation: record.certificateValidation, ssl: {provider: 'cloudflare', managed: true, automaticRenewal: true, method: record.certificateMethod || 'http', status: record.certificateStatus || 'pending', checkedAt: record.checkedAt, nextCheckAt: record.nextCheckAt, lastError: record.lastError}};
  }
  async handle(request) {
    const input = await request.json();
    if (new URL(request.url).pathname === '/monitor') { await this.schedule(); return json({ok: true}); }
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
      if (reservations.size >= this.limit()) return json({error: 'custom_hostname_limit'}, 409);
      const value = {hostname: name, tenantId: input.tenantId, token: crypto.randomUUID(), status: 'pending_ownership', nextCheckAt: Date.now() + 60000};
      await this.ctx.storage.put(key, value);
      await this.schedule();
      return json(this.public(value), 201);
    }
    if (!record) return json({error: 'not_found'}, 404);
    if (action === '/status') return json(this.public(record));
    if (action === '/delete') {
      await this.ctx.storage.put(key, {...record, status: 'deleting'});
      if (record.cloudflareId) await api(this.env, 'DELETE', `/${record.cloudflareId}`);
      await this.ctx.storage.delete(key);
      await this.schedule();
      return json({deleted: true});
    }
    if (action !== '/verify') return json({error: 'not_found'}, 404);
    const proof = await dns(`_spartan-verification.${name}`, 'TXT');
    if (!proof.some(answer => answer.type === 16 && answer.name.toLowerCase().replace(/\.$/, '') === `_spartan-verification.${name}` && txt(answer.data) === record.token)) {
      const pending = {...record, status: 'pending_ownership', checkedAt: new Date().toISOString(), nextCheckAt: Date.now() + 300000};
      await this.ctx.storage.put(key, pending);
      await this.schedule();
      return json({error: 'ownership_not_verified', ...this.public(pending)}, 409);
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
        const created = await api(this.env, 'POST', '', {hostname: name, ssl: {method: 'http', type: 'dv', settings: {min_tls_version: '1.2'}}});
        record.cloudflareId = created.id;
      }
      await this.ctx.storage.put(key, record);
    }
    const remote = await api(this.env, 'GET', `/${record.cloudflareId}`);
    const cnames = await dns(name, 'CNAME');
    const pointed = cnames.some(answer => answer.type === 5 && answer.name.toLowerCase().replace(/\.$/, '') === name && answer.data.toLowerCase().replace(/\.$/, '') === this.env.SAAS_CNAME_TARGET);
    const active = remote.hostname === name && remote.status === 'active' && remote.ssl?.status === 'active' && pointed;
    const value = {...record, checkedAt: new Date().toISOString(), nextCheckAt: Date.now() + (active ? 21600000 : 300000), lastError: undefined, certificateMethod: remote.ssl?.method || 'http', certificateStatus: remote.ssl?.status, cloudflareOwnership: remote.ownership_verification, certificateValidation: remote.ssl?.validation_records, status: active ? 'active' : 'pending_certificate'};
    await this.ctx.storage.put(key, value);
    await this.schedule();
    return json(this.public(value));
  }
  async alarm() {
    const result = this.tail.then(async () => {
      const records = await this.ctx.storage.list({prefix: 'domain:'});
      const due = [...records.values()].filter(record => record.status !== 'deleting' && (record.nextCheckAt || 0) <= Date.now()).sort((left, right) => (left.nextCheckAt || 0) - (right.nextCheckAt || 0)).slice(0, 3);
      for (const record of due) {
        const key = `domain:${record.hostname}`;
        try {
          const response = await this.handle(new Request('https://domains/verify', {method: 'POST', body: JSON.stringify({hostname: record.hostname, tenantId: record.tenantId})}));
          if (!response.ok) {
            const current = await this.ctx.storage.get(key);
            if (current) await this.ctx.storage.put(key, {...current, lastError: (await response.json()).error || 'certificate_check_failed', nextCheckAt: Date.now() + 300000});
          }
        } catch {
          const current = await this.ctx.storage.get(key);
          if (current) await this.ctx.storage.put(key, {...current, lastError: 'certificate_check_failed', nextCheckAt: Date.now() + 300000});
        }
      }
      await this.schedule();
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
