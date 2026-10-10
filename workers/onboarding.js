import {ID, json} from './shared.js';
import {hostname} from './domain-utils.js';
import {readRoute, registerRoute} from './store.js';
import {domainAction} from './domains-d1.js';
import {issueDomainPermit} from '../node/domain-permit.mjs';
import {customerRoute} from './customer-routes.js';

const field = /^[A-Za-z0-9_-]{1,100}$/;

function records(domain) {
  const values = [
    {...domain.cname, purpose: 'routing'},
    {...domain.ownership, purpose: 'spartan_ownership'},
  ];
  if (domain.cloudflareOwnership?.name && domain.cloudflareOwnership?.value) values.push({type: 'TXT', name: domain.cloudflareOwnership.name, value: domain.cloudflareOwnership.value, purpose: 'cloudflare_ownership'});
  for (const record of Array.isArray(domain.certificateValidation) ? domain.certificateValidation : []) {
    if (record.txt_name && (record.txt_value || record.txt_record)) values.push({type: 'TXT', name: record.txt_name, value: record.txt_value || record.txt_record, purpose: 'certificate_validation'});
    if (record.cname_name && record.cname_target) values.push({type: 'CNAME', name: record.cname_name, target: record.cname_target, purpose: 'certificate_validation'});
  }
  return values;
}

export async function onboardingAction(env, action, input, now = Date.now()) {
  if (!input || !ID.test(input.id || '') || !field.test(input.serviceId || '') || !field.test(input.customerId || '')) return json({error: 'invalid_onboarding'}, 400);
  let name;
  try { name = hostname(input.hostname, env); } catch (error) { return json({error: error.message}, 400); }
  const existing = await readRoute(env, input.id);
  if (existing && (existing.serviceId !== input.serviceId || existing.customerId !== input.customerId || action === 'prepare' && existing.primary !== input.primary)) return json({error: 'service_conflict'}, 409);
  if (existing && !['pending', 'ready'].includes(existing.status)) return json({error: 'service_not_active'}, 409);
  if (action === 'prepare' && !existing) {
    if (!['us', 'de'].includes(input.primary)) return json({error: 'invalid_region'}, 400);
    const result = await registerRoute(env, {id: input.id, serviceId: input.serviceId, customerId: input.customerId, primary: input.primary, status: 'pending', lifecycleVersion: 0});
    if (result.error) return json({error: result.error}, 409);
  } else if (!existing) return json({error: 'not_found'}, 404);
  const response = await domainAction(env, action === 'prepare' ? 'reserve' : action, {hostname: name, tenantId: input.id, certificateMethod: 'txt'}, now);
  const domain = await response.json();
  if (!domain.hostname) return json(domain, response.status);
  const dnsReady = domain.status === 'active' && domain.ssl?.status === 'active';
  const routing = dnsReady ? await customerRoute(env, name, action === 'verify') : {ready: false};
  if (routing.error) return json({...domain, error: routing.error, required: true, readyToProvision: false, stage: 'routing_setup', dnsRecords: records(domain)}, 503);
  const ready = dnsReady && routing.ready === true;
  const permit = ready && action === 'verify' ? await issueDomainPermit(env.ORIGIN_SECRET, input.id, name, now) : null;
  return json({
    ...domain, id: input.id, serviceId: input.serviceId, customerId: input.customerId,
    required: !ready, readyToProvision: ready,
    stage: ready ? 'ready_to_provision' : dnsReady ? 'routing_setup' : domain.status === 'pending_ownership' ? 'spartan_ownership' : 'cloudflare_validation',
    dnsRecords: records(domain),
    domainVerificationToken: permit?.token,
    tokenExpiresAt: permit ? new Date(permit.expiresAt).toISOString() : undefined,
  }, response.status);
}
