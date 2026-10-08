import {ID, json} from './shared.js';
import {hostname, api, dns, txt} from './domain-utils.js';
import {readRoute, readDomain, insertDomain, updateDomain, deleteDomain, countDomains, countCloudflareSlots, claimCreateAttempt, dueDomains} from './store.js';

function limit(env) {
  const value = Number(env.MAX_CUSTOM_HOSTNAMES || 30);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('invalid_hostname_limit');
  return value;
}
export function publicDomain(record, env) {
  return {hostname: record.hostname, tenantId: record.tenantId, status: record.status, cname: {type: 'CNAME', name: record.hostname, target: env.SAAS_CNAME_TARGET, proxied: false}, ownership: {type: 'TXT', name: `_spartan-verification.${record.hostname}`, value: record.token}, certificateStatus: record.certificateStatus, cloudflareOwnership: record.cloudflareOwnership, certificateValidation: record.certificateValidation, ssl: {provider: 'cloudflare', managed: true, automaticRenewal: true, method: record.certificateMethod || 'http', status: record.certificateStatus || 'pending', checkedAt: record.checkedAt, nextCheckAt: record.nextCheckAt, lastError: record.lastError}};
}

export async function domainAction(env, action, input, now = Date.now()) {
  try { return await handle(env, action, input, now); }
  catch (error) {
    const client = ['invalid_hostname', 'reserved_hostname', 'invalid_tenant'].includes(error.message);
    return json({error: client ? error.message : 'domain_operation_failed'}, client ? 400 : 503);
  }
}

async function handle(env, action, input, now) {
  const name = hostname(input.hostname, env);
  let record = await readDomain(env, name);
  if (action === 'resolve') {
    if (!record || record.status !== 'active') return json({error: 'not_found'}, 404);
    return json({id: record.tenantId});
  }
  if (!ID.test(input.tenantId || '')) throw new Error('invalid_tenant');
  if (record && record.tenantId !== input.tenantId) return json({error: 'hostname_conflict'}, 409);
  const tenant = await readRoute(env, input.tenantId);
  if (!tenant || tenant.status !== 'ready') return json({error: 'tenant_not_ready'}, 409);
  if (action === 'reserve') {
    if (record) return json(publicDomain(record, env));
    if (await countDomains(env) >= limit(env)) return json({error: 'custom_hostname_limit'}, 409);
    const inserted = await insertDomain(env, {hostname: name, tenantId: input.tenantId, token: crypto.randomUUID(), status: 'pending_ownership', nextCheckAt: now + 60000});
    return json(publicDomain(inserted.record, env), inserted.created ? 201 : 200);
  }
  if (!record) return json({error: 'not_found'}, 404);
  if (action === 'status') return json(publicDomain(record, env));
  if (action === 'delete') {
    await updateDomain(env, name, {status: 'deleting'});
    if (record.cloudflareId) await api(env, 'DELETE', `/${record.cloudflareId}`);
    await deleteDomain(env, name);
    return json({deleted: true});
  }
  if (action !== 'verify') return json({error: 'not_found'}, 404);
  const proof = await dns(`_spartan-verification.${name}`, 'TXT');
  if (!proof.some(answer => answer.type === 16 && answer.name.toLowerCase().replace(/\.$/, '') === `_spartan-verification.${name}` && txt(answer.data) === record.token)) {
    const pending = await updateDomain(env, name, {status: 'pending_ownership', checkedAt: new Date(now).toISOString(), nextCheckAt: now + 300000});
    return json({error: 'ownership_not_verified', ...publicDomain(pending, env)}, 409);
  }
  if (!record.cloudflareId) {
    const existing = await api(env, 'GET', `?hostname=${encodeURIComponent(name)}`);
    const found = existing.find(value => value.hostname === name);
    if (found && !record.createAttempted) return json({error: 'hostname_already_registered'}, 409);
    if (found) record = await updateDomain(env, name, {cloudflareId: found.id});
    else {
      const quota = await api(env, 'GET', '/quota');
      if (!Number.isSafeInteger(quota.used) || quota.used < 0) throw new Error('unknown_quota');
      if (Math.max(quota.used, await countCloudflareSlots(env)) >= 100) return json({error: 'free_hostname_limit'}, 409);
      // Only the caller that flips createAttempted may create the hostname. A loser returns
      // the current record; the documented workflow already polls status after verify.
      if (!await claimCreateAttempt(env, name)) return json(publicDomain(await readDomain(env, name), env));
      const created = await api(env, 'POST', '', {hostname: name, ssl: {method: 'http', type: 'dv', settings: {min_tls_version: '1.2'}}});
      record = await updateDomain(env, name, {cloudflareId: created.id});
    }
  }
  const remote = await api(env, 'GET', `/${record.cloudflareId}`);
  const cnames = await dns(name, 'CNAME');
  const pointed = cnames.some(answer => answer.type === 5 && answer.name.toLowerCase().replace(/\.$/, '') === name && answer.data.toLowerCase().replace(/\.$/, '') === env.SAAS_CNAME_TARGET);
  const active = remote.hostname === name && remote.status === 'active' && remote.ssl?.status === 'active' && pointed;
  const value = await updateDomain(env, name, {checkedAt: new Date(now).toISOString(), nextCheckAt: now + (active ? 21600000 : 300000), lastError: undefined, certificateMethod: remote.ssl?.method || 'http', certificateStatus: remote.ssl?.status, cloudflareOwnership: remote.ownership_verification, certificateValidation: remote.ssl?.validation_records, status: active ? 'active' : 'pending_certificate'});
  return json(publicDomain(value, env));
}

// Replaces the Domains Durable Object alarm. D1 has no timers, so the Worker's cron
// trigger drives the certificate sweep instead.
export async function monitorDomains(env, now = Date.now()) {
  const due = await dueDomains(env, now);
  for (const record of due) {
    try {
      const response = await domainAction(env, 'verify', {hostname: record.hostname, tenantId: record.tenantId}, now);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        await updateDomain(env, record.hostname, {lastError: body.error || 'certificate_check_failed', nextCheckAt: now + 300000});
      }
    } catch {
      await updateDomain(env, record.hostname, {lastError: 'certificate_check_failed', nextCheckAt: now + 300000});
    }
  }
  return due.length;
}
