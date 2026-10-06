import {ID, REGIONS, json, digest, verify, nodeCall, validInitialAdmin, sealAdmin, openAdmin} from './shared.js';
export {Recovery} from './recovery.js';
export {Domains} from './domains.js';

export class Tenant {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
  }
  async handle(request) {
    const path = new URL(request.url).pathname;
    if (path === '/reserve' && request.method === 'POST') {
      const input = await request.json();
      {
        const existing = await this.ctx.storage.get('record');
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) return json({error: 'service_conflict'}, 409);
          return json(this.public(existing), existing.status === 'ready' ? 200 : 202);
        }
        const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
        const record = {...input, appKey: `base64:${key}`, status: 'pending', createdAt: new Date().toISOString(), attempts: 0};
        await this.ctx.storage.transaction(async tx => {
          await tx.put('record', record);
          await tx.setAlarm(Date.now() + 1000);
        });
        return json(this.public(record), 202);
      }
    }
    const record = await this.ctx.storage.get('record');
    if (!record) return json({error: 'not_found'}, 404);
    if (path === '/internal') return json(record);
    if (path === '/complete' && request.method === 'POST') {
      const {initialAdminEncrypted, ...completed} = record;
      await this.ctx.storage.put('record', {...completed, status: 'ready', readyAt: new Date().toISOString()});
      await this.ctx.storage.deleteAlarm();
      return json({ok: true});
    }
    if (path === '/failure' && request.method === 'POST') {
      const {error} = await request.json();
      if (record.status !== 'ready') await this.ctx.storage.put('record', {...record, lastError: error});
      return json({ok: true});
    }
    return json(this.public(record));
  }
  public(record) {
    return {id: record.id, serviceId: record.serviceId, primary: record.primary, status: record.status, url: record.url, createdAt: record.createdAt, readyAt: record.readyAt};
  }
  async alarm() {
    const record = await this.ctx.storage.get('record');
    if (!record || record.status === 'ready') return;
    await this.ctx.storage.setAlarm(Date.now() + 300000);
    await this.ctx.storage.put('record', {...record, attempts: record.attempts + 1});
    await this.env.PROVISION_QUEUE.send({id: record.id});
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!['GET', 'POST'].includes(request.method)) return json({error: 'method_not_allowed'}, 405);
      if (Number(request.headers.get('content-length') || 0) > 16384) return json({error: 'too_large'}, 413);
      const body = await request.text();
      if (body.length > 16384) return json({error: 'too_large'}, 413);
      if (url.pathname === '/v1/recovery') {
        if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405);
        if (!await verify(request, body, env.AI_RECOVERY_SECRET)) return json({error: 'unauthorized'}, 401);
        return env.RECOVERY.getByName('global-budget').fetch('https://recovery/choose', {method: 'POST', body});
      }
      if (!await verify(request, body, env.BILLING_WEBHOOK_SECRET)) return json({error: 'unauthorized'}, 401);
      const domain = url.pathname.match(/^\/v1\/instances\/(t-[a-f0-9]{24})\/domains\/(reserve|verify|status|delete)$/);
      if (request.method === 'POST' && domain) {
        const input = JSON.parse(body);
        return env.DOMAINS.getByName('registry').fetch(`https://domains/${domain[2]}`, {method: 'POST', body: JSON.stringify({hostname: input.hostname, tenantId: domain[1]})});
      }
      if (request.method === 'POST' && url.pathname === '/v1/instances') {
        const input = JSON.parse(body);
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.serviceId || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(input.customerId || '') || !REGIONS.has(input.primary)) return json({error: 'invalid_input'}, 400);
        if (input.initialAdmin !== undefined && !validInitialAdmin(input.initialAdmin)) return json({error: 'invalid_initial_admin'}, 400);
        const id = `t-${(await digest(input.serviceId)).slice(0, 24)}`;
        const fingerprint = await digest(JSON.stringify([input.serviceId, input.customerId, input.primary, ...(input.initialAdmin ? [input.initialAdmin.displayName, input.initialAdmin.email, input.initialAdmin.password, env.BILLING_WEBHOOK_SECRET] : [])]));
        const record = {id, fingerprint, ...(input.initialAdmin ? {initialAdminEncrypted: await sealAdmin(input.initialAdmin, env.NODE_CONTROL_SECRET)} : {}), serviceId: input.serviceId, customerId: input.customerId, primary: input.primary, url: `https://${id}.${env.BASE_DOMAIN}`};
        return env.TENANTS.getByName(id).fetch('https://tenant/reserve', {method: 'POST', body: JSON.stringify(record)});
      }
      const match = url.pathname.match(/^\/v1\/instances\/(t-[a-f0-9]{24})$/);
      if (request.method === 'GET' && match) return env.TENANTS.getByName(match[1]).fetch('https://tenant/status');
      return json({error: 'not_found'}, 404);
    } catch (error) {
      return json({error: error instanceof SyntaxError ? 'invalid_json' : 'internal_error'}, error instanceof SyntaxError ? 400 : 500);
    }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const id = message.body.id;
      if (!ID.test(id || '')) { message.ack(); continue; }
      const stub = env.TENANTS.getByName(id);
      try {
        const response = await stub.fetch('https://tenant/internal');
        if (!response.ok) { message.ack(); continue; }
        const record = await response.json();
        if (record.status === 'ready') { message.ack(); continue; }
        const {initialAdminEncrypted, ...replicaRecord} = record;
        const primaryRecord = {...replicaRecord, ...(initialAdminEncrypted ? {initialAdmin: await openAdmin(initialAdminEncrypted, env.NODE_CONTROL_SECRET)} : {})};
        const primary = await nodeCall(env, record.primary, '/control/provision', primaryRecord);
        if (primary.status !== 'ready') throw new Error('primary_not_ready');
        const secondary = await nodeCall(env, record.primary === 'us' ? 'de' : 'us', '/control/provision', replicaRecord);
        if (secondary.status !== 'ready') throw new Error('secondary_not_ready');
        await stub.fetch('https://tenant/complete', {method: 'POST'});
        message.ack();
      } catch (error) {
        await stub.fetch('https://tenant/failure', {method: 'POST', body: JSON.stringify({error: String(error.message).slice(0, 120)})});
        message.retry({delaySeconds: 60});
      }
    }
  }
};
