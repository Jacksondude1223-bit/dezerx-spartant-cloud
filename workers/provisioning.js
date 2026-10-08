import {ID, REGIONS, json, digest, verify, nodeCall, validInitialAdmin, validLicenseKey, tenantAppUrl, sealAdmin, openAdmin} from './shared.js';
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
          if (existing.desiredStatus === 'terminated') return json({error: 'service_terminated'}, 409);
          if (existing.fingerprint !== input.fingerprint) return json({error: 'service_conflict'}, 409);
          return json(this.public(existing), existing.status === 'ready' ? 200 : 202);
        }
        const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
        const record = {...input, appKey: `base64:${key}`, status: 'pending', desiredStatus: 'active', lifecycleVersion: 0, createdAt: new Date().toISOString(), attempts: 0};
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
    if (path === '/reconfigure' && request.method === 'POST') {
      const input = await request.json();
      if ((record.desiredStatus || 'active') !== 'active') return json({error: 'service_terminated'}, 409);
      // Only a serving tenant can be reconfigured: the node rewrites app.env and then
      // recreates the container, which needs a container to be there already.
      if (record.status !== 'ready') return json({error: 'service_not_ready'}, 409);
      if (input.url === record.url && input.licenseKey === record.licenseKey) return json(this.public(record));
      const updated = {...record, url: input.url, licenseKey: input.licenseKey};
      await this.ctx.storage.put('record', updated);
      // The status stays 'ready' throughout, so routing never takes the tenant offline for
      // a domain change; the queue applies the new environment to both nodes.
      await this.env.PROVISION_QUEUE.send({id: record.id, action: 'reconfigure'});
      return json(this.public(updated), 202);
    }
    if (path === '/lifecycle' && request.method === 'POST') {
      const input = await request.json();
      if (!['active', 'suspended', 'terminated'].includes(input.status)) return json({error: 'invalid_service_status'}, 400);
      if (input.serviceId && input.serviceId !== record.serviceId) return json({error: 'service_conflict'}, 409);
      const desired = record.desiredStatus || 'active';
      if (desired === 'terminated' && input.status !== 'terminated') return json({error: 'service_terminated'}, 409);
      if (desired === input.status) return json(this.public(record), ['ready', 'suspended', 'terminated'].includes(record.status) ? 200 : 202);
      const updated = {...record, desiredStatus: input.status, lifecycleVersion: (record.lifecycleVersion || 0) + 1, status: input.status === 'active' ? 'pending' : input.status === 'suspended' ? 'suspending' : 'terminating', lastError: undefined};
      if (input.status === 'terminated') delete updated.initialAdminEncrypted;
      await this.ctx.storage.transaction(async tx => { await tx.put('record', updated); await tx.setAlarm(Date.now() + 1000); });
      return json(this.public(updated), 202);
    }
    if (path === '/lifecycle-complete' && request.method === 'POST') {
      const input = await request.json();
      if (input.lifecycleVersion !== (record.lifecycleVersion || 0) || input.status !== record.desiredStatus || !['suspended', 'terminated'].includes(input.status)) return json({error: 'stale_operation'}, 409);
      await this.ctx.storage.put('record', {...record, status: input.status, updatedAt: new Date().toISOString()});
      await this.ctx.storage.deleteAlarm();
      return json({ok: true});
    }
    if (path === '/complete'  && request.method === 'POST') {
      const input = await request.json().catch(() => ({}));
      if ((record.desiredStatus || 'active') !== 'active' || (input.lifecycleVersion || 0) !== (record.lifecycleVersion || 0)) return json({error: 'stale_operation'}, 409);
      const {initialAdminEncrypted, ...completed} = record;
      await this.ctx.storage.put('record', {...completed, status: 'ready', readyAt: new Date().toISOString()});
      await this.ctx.storage.deleteAlarm();
      return json({ok: true});
    }
    if (path === '/failure' && request.method === 'POST') {
      const {error, lifecycleVersion = 0} = await request.json();
      if (lifecycleVersion !== (record.lifecycleVersion || 0)) return json({ok: true});
      if (record.status !== 'ready') await this.ctx.storage.put('record', {...record, lastError: error});
      return json({ok: true});
    }
    return json(this.public(record));
  }
  public(record) {
    return {id: record.id, serviceId: record.serviceId, primary: record.primary, status: record.status, desiredStatus: record.desiredStatus || 'active', lifecycleVersion: record.lifecycleVersion || 0, url: record.url, createdAt: record.createdAt, readyAt: record.readyAt};
  }
  async alarm() {
    const record = await this.ctx.storage.get('record');
    if (!record || ['ready', 'suspended', 'terminated'].includes(record.status)) return;
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
      if (request.method === 'POST' && url.pathname === '/v1/services/status') {
        const input = JSON.parse(body);
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.serviceId || '') || !['active', 'suspended', 'terminated'].includes(input.status)) return json({error: 'invalid_service_status'}, 400);
        const id = `t-${(await digest(input.serviceId)).slice(0, 24)}`;
        return env.TENANTS.getByName(id).fetch('https://tenant/lifecycle', {method: 'POST', body: JSON.stringify(input)});
      }
      const lifecycle = url.pathname.match(/^\/v1\/instances\/(t-[a-f0-9]{24})\/lifecycle$/);
      if (request.method === 'POST' && lifecycle) return env.TENANTS.getByName(lifecycle[1]).fetch('https://tenant/lifecycle', {method: 'POST', body});
      const appUrlPath = url.pathname.match(/^\/v1\/instances\/(t-[a-f0-9]{24})\/app-url$/);
      if (request.method === 'POST' && appUrlPath) {
        const input = JSON.parse(body);
        // A licence is issued per domain, so a new domain needs the licence issued for it.
        if (!validLicenseKey(input.licenseKey)) return json({error: 'invalid_license_key'}, 400);
        const next = tenantAppUrl(env, appUrlPath[1], input.domain);
        if (!next) return json({error: 'invalid_domain'}, 400);
        return env.TENANTS.getByName(appUrlPath[1]).fetch('https://tenant/reconfigure', {method: 'POST', body: JSON.stringify({url: next, licenseKey: input.licenseKey})});
      }
      const domain = url.pathname.match(/^\/v1\/instances\/(t-[a-f0-9]{24})\/domains\/(reserve|verify|status|delete)$/);
      if (request.method === 'POST' && domain) {
        const input = JSON.parse(body);
        return env.DOMAINS.getByName('registry').fetch(`https://domains/${domain[2]}`, {method: 'POST', body: JSON.stringify({hostname: input.hostname, tenantId: domain[1]})});
      }
      if (request.method === 'POST' && url.pathname === '/v1/instances') {
        const input = JSON.parse(body);
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.serviceId || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(input.customerId || '') || !REGIONS.has(input.primary)) return json({error: 'invalid_input'}, 400);
        if (!validLicenseKey(input.licenseKey)) return json({error: 'invalid_license_key'}, 400);
        if (input.initialAdmin !== undefined && !validInitialAdmin(input.initialAdmin)) return json({error: 'invalid_initial_admin'}, 400);
        const id = `t-${(await digest(input.serviceId)).slice(0, 24)}`;
        // The tenant's own URL is the customer's domain, because that is the domain the
        // licence was issued for. Routing still reaches it through the shared subdomain.
        const url = tenantAppUrl(env, id, input.domain);
        if (!url) return json({error: 'invalid_domain'}, 400);
        // The licence and the domain are deliberately outside the fingerprint: both are
        // expected to change over a service's life, and neither changes who owns it.
        const fingerprint = await digest(JSON.stringify([input.serviceId, input.customerId, input.primary, ...(input.initialAdmin ? [input.initialAdmin.displayName, input.initialAdmin.email, input.initialAdmin.password, env.BILLING_WEBHOOK_SECRET] : [])]));
        const record = {id, fingerprint, ...(input.initialAdmin ? {initialAdminEncrypted: await sealAdmin(input.initialAdmin, env.NODE_CONTROL_SECRET)} : {}), serviceId: input.serviceId, customerId: input.customerId, primary: input.primary, licenseKey: input.licenseKey, url};
        return env.TENANTS.getByName(id).fetch('https://tenant/reserve', {method: 'POST', body: JSON.stringify(record)});
      }
      const match = url.pathname.match(/^\/v1\/instances\/(t-[a-f0-9]{24})$/);
      if (request.method === 'GET' && match) return env.TENANTS.getByName(match[1]).fetch('https://tenant/status');
      return json({error: 'not_found'}, 404);
    } catch (error) {
      return json({error: error instanceof SyntaxError ? 'invalid_json' : 'internal_error'}, error instanceof SyntaxError ? 400 : 500);
    }
  },
  async scheduled(event, env) {
    if (!env.CF_SAAS_API_TOKEN) return;
    const response = await env.DOMAINS.getByName('registry').fetch('https://domains/monitor', {method: 'POST', body: '{}'});
    if (!response.ok) throw new Error('ssl_monitor_failed');
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const id = message.body.id;
      if (!ID.test(id || '')) { message.ack(); continue; }
      const stub = env.TENANTS.getByName(id);
      let operationVersion = 0;
      try {
        const response = await stub.fetch('https://tenant/internal');
        if (!response.ok) { message.ack(); continue; }
        const record = await response.json();
        operationVersion = record.lifecycleVersion || 0;
        if (message.body.action === 'reconfigure') {
          if (record.status !== 'ready' || ['suspended', 'terminated'].includes(record.desiredStatus)) { message.ack(); continue; }
          const {initialAdminEncrypted, ...current} = record;
          // Provisioning rewrites app.env without touching the running container, and the
          // upgrade then recreates it, so the tenant only restarts once per node.
          for (const location of [record.primary, record.primary === 'us' ? 'de' : 'us']) {
            const provisioned = await nodeCall(env, location, '/control/provision', current);
            if (provisioned.status !== 'ready') throw new Error('reconfigure_not_ready');
            const applied = await nodeCall(env, location, '/control/upgrade', {id, fingerprint: record.fingerprint});
            if (!['upgraded', 'current'].includes(applied.status)) throw new Error('reconfigure_failed');
          }
          message.ack();
          continue;
        }
        if (['ready', 'suspended', 'terminated'].includes(record.status)) { message.ack(); continue; }
        if (['suspended', 'terminated'].includes(record.desiredStatus)) {
          const input = {id, fingerprint: record.fingerprint, lifecycleVersion: record.lifecycleVersion || 0, action: record.desiredStatus};
          const results = await Promise.allSettled(['us', 'de'].map(region => nodeCall(env, region, '/control/lifecycle', input)));
          if (results.some(result => result.status !== 'fulfilled' || result.value.status !== record.desiredStatus)) throw new Error('lifecycle_node_failed');
          const completed = await stub.fetch('https://tenant/lifecycle-complete', {method: 'POST', body: JSON.stringify({status: record.desiredStatus, lifecycleVersion: record.lifecycleVersion || 0})});
          if (!completed.ok) throw new Error('stale_operation');
          message.ack();
          continue;
        }
        const {initialAdminEncrypted, ...replicaRecord} = record;
        const primaryRecord = {...replicaRecord, ...(initialAdminEncrypted ? {initialAdmin: await openAdmin(initialAdminEncrypted, env.NODE_CONTROL_SECRET)} : {})};
        const primary = await nodeCall(env, record.primary, '/control/provision', primaryRecord);
        if (primary.status !== 'ready') throw new Error('primary_not_ready');
        const secondary = await nodeCall(env, record.primary === 'us' ? 'de' : 'us', '/control/provision', replicaRecord);
        if (secondary.status !== 'ready') throw new Error('secondary_not_ready');
        const completed = await stub.fetch('https://tenant/complete', {method: 'POST', body: JSON.stringify({lifecycleVersion: record.lifecycleVersion || 0})});
        if (!completed.ok) throw new Error('stale_operation');
        message.ack();
      } catch (error) {
        await stub.fetch('https://tenant/failure', {method: 'POST', body: JSON.stringify({error: String(error.message).slice(0, 120), lifecycleVersion: operationVersion})});
        message.retry({delaySeconds: 60});
      }
    }
  }
};
