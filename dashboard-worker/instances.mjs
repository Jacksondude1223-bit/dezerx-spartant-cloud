import {ApiError, view} from './store.mjs';
import {random, digest, base64} from './crypto.mjs';
import {validLicenseKey} from '../node/license.mjs';
import {validInitialAdmin} from '../node/admin-validation.mjs';
import {issueDomainPermit} from '../node/domain-permit.mjs';
import {upstreamDetails} from './nodes.mjs';
const products = {SPARTANSTARTER_: 'Starter', SPARTANCLOUD_: 'Cloud', SPARTANCLOUDPLUS_: 'Cloud Plus', SPARTANPROFESSIONAL_: 'Professional', SPARTANULTIMATE_: 'Ultimate', SPARTANDEV_: 'Developer'};
export const productName = key => products[Object.keys(products).find(x => key?.startsWith(x))] || null;
export function hostname(value) {
  const name = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.$/, '');
  return name.length <= 200 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name) ? name : null;
}
export const onboarding = item => ({id: item.id, serviceId: item.serviceId, customerId: item.customerId, primary: item.primary, hostname: item.hostname});
export const dnsView = result => ({stage: result.stage, readyToProvision: result.readyToProvision === true, records: result.dnsRecords || [], status: result.status, certificateStatus: result.ssl?.status || result.certificateStatus || null, checkedAt: new Date().toISOString()});
async function assignHostname(item, client) {
  await client.routing('instances', {id: item.id, serviceId: item.serviceId, customerId: item.customerId, primary: item.primary, status: 'pending', lifecycleVersion: 0});
  const assigned = await client.routing(`instances/${item.id}/hostname`);
  if (!hostname(assigned.hostname)) throw new ApiError(502, 'invalid_assigned_hostname');
  item.hostname = hostname(assigned.hostname); item.status = 'ready_to_deploy'; item.error = null; item.setupError = null;
}
export async function verifyDomain(item, client, db) {
  let result;
  try {result = await client.routing('onboarding/verify', onboarding(item));}
  catch (error) {if (!error.data?.hostname) throw error; result = error.data;}
  item.dns = dnsView(result);
  if (['awaiting_dns', 'ready_to_deploy'].includes(item.status)) item.status = result.readyToProvision ? 'ready_to_deploy' : 'awaiting_dns';
  db.note(item, 'Domain verification: ' + (result.stage || result.status || 'pending'));
  await db.save(item);
  return result;
}
export async function permit(item, env, client, db) {
  if (!item.custom) return (await issueDomainPermit(env.ORIGIN_SECRET, item.id, item.hostname)).token;
  const result = await verifyDomain(item, client, db);
  if (!result.readyToProvision || !result.domainVerificationToken) throw new ApiError(409, 'domain_verification_required');
  return result.domainVerificationToken;
}
export async function createInstance(input, user, env, client, db) {
  const primary = input.primary;
  if (!['us', 'de'].includes(primary)) throw new ApiError(400, 'invalid_region');
  if (env.DATABASE_MODE === 'us-central' && primary !== 'us') throw new ApiError(409, 'us_database_required');
  const licenseKey = typeof input.licenseKey === 'string' && input.licenseKey.trim() ? input.licenseKey.trim() : null;
  const domain = input.domain ? hostname(input.domain) : null;
  if (input.domain && !domain) throw new ApiError(400, 'invalid_domain');
  if ((licenseKey || domain) && !validLicenseKey(licenseKey)) throw new ApiError(400, 'invalid_license_key');
  const customerId = input.customerId || 'dashboard';
  if (typeof customerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(customerId)) throw new ApiError(400, 'invalid_customer_id');
  const reserved = [client.config.baseDomain, ...Object.values(client.config.origins).map(x => new URL(x).hostname)];
  if (domain && reserved.some(x => domain === x || domain.endsWith('.' + x))) throw new ApiError(400, 'reserved_hostname');
  const serviceId = 'dash_' + random(10), id = 't-' + (await digest(serviceId)).slice(0, 24);
  const item = {id, serviceId, customerId, primary, secondary: primary === 'us' ? 'de' : 'us', licenseKey, product: productName(licenseKey), hostname: domain, custom: Boolean(domain), appKey: 'base64:' + base64(crypto.getRandomValues(new Uint8Array(32))), fingerprint: await digest(JSON.stringify([serviceId, customerId, primary])), lifecycleVersion: 0, status: 'preparing', steps: {}, createdBy: user, createdAt: new Date().toISOString()};
  await db.insert(item);
  try {
    if (domain) {
      let result;
      try {result = await client.routing('onboarding/prepare', onboarding(item));}
      catch (error) {if (!error.data?.hostname) throw error; result = error.data;}
      item.dns = dnsView(result); item.status = 'awaiting_dns';
    } else {
      await assignHostname(item, client);
    }
    db.note(item, `Created by ${user}. ${domain ? 'Verify the DNS records before deployment.' : 'The routing Worker assigned ' + item.hostname + '.'}`);
    await db.save(item);
    await db.audit('action', {action: 'instance_create', user, id});
    return view(item);
  } catch (error) {
    item.status = 'failed'; item.error = error.message; item.setupError = upstreamDetails(error.data);
    if (!item.custom && hostname(error.data?.hostname)) item.hostname = hostname(error.data.hostname);
    db.note(item, `Setup failed: ${item.error}${item.setupError.reason ? ' (' + item.setupError.reason + ')' : ''}.`, 'bad');
    await db.save(item); error.instanceId = item.id; throw error;
  }
}
export async function deployInstance(item, input, user, db) {
  if (['ready', 'deploying', 'queued', 'suspended', 'terminated', 'preparing'].includes(item.status)) throw new ApiError(409, 'instance_busy');
  if (item.custom && !item.dns?.readyToProvision) throw new ApiError(409, 'domain_not_verified');
  if (!hostname(item.hostname)) throw new ApiError(409, 'hostname_not_ready');
  if (input.initialAdmin !== undefined && !validInitialAdmin(input.initialAdmin)) throw new ApiError(400, 'invalid_initial_admin');
  const license = input.licenseKey?.trim() || item.licenseKey;
  if (!validLicenseKey(license)) throw new ApiError(400, license ? 'invalid_license_key' : 'license_key_required');
  if (item.licenseKey && license !== item.licenseKey && (item.steps.primary === 'done' || item.steps.secondary === 'done')) throw new ApiError(409, 'license_locked');
  item.licenseKey = license; item.product = productName(license); item.adminCreation = input.initialAdmin ? 'automatic' : 'signup';
  item.status = 'queued'; item.error = null; item.progress = null;
  item.queue = {position: 1, length: 1, since: new Date().toISOString(), reason: 'Waiting for the persistent deployment runner.'};
  db.note(item, `Deployment requested by ${user}. Account setup: ${item.adminCreation}.`);
  await db.enqueue(item, 'deploy', {initialAdmin: input.initialAdmin || null}, item.steps.primary === 'done' ? item.steps.secondary === 'done' ? 'routing' : 'secondary' : 'primary', Date.now() + 7 * 86400000);
  await db.audit('action', {action: 'instance_deploy', user, id: item.id});
  return view(item);
}
export async function instanceAction(item, action, input, user, env, client, db) {
  if (action === 'deploy') return deployInstance(item, input, user, db);
  if (action === 'verify') {
    if (['queued', 'deploying', 'ready', 'suspended', 'terminated'].includes(item.status)) throw new ApiError(409, 'instance_busy');
    if (item.custom) await verifyDomain(item, client, db);
    else if (!hostname(item.hostname) || ['instance_hostname_setup_failed', 'instance_domain_configuration_required', 'invalid_assigned_hostname'].includes(item.error)) {
      try {await assignHostname(item, client); db.note(item, 'Hostname attached. Ready to deploy.', 'good'); await db.save(item);}
      catch (error) {item.status = 'failed'; item.error = error.message; item.setupError = upstreamDetails(error.data); await db.save(item); error.instanceId = item.id; throw error;}
    }
    return view(item);
  }
  if (action === 'cancel') {
    if (item.status !== 'queued') throw new ApiError(409, 'not_queued');
    item.status = item.custom && !item.dns?.readyToProvision ? 'awaiting_dns' : 'ready_to_deploy'; item.queue = null;
    const encoded = await db.encode(item);
    const results = await db.db.batch([
      db.query("UPDATE dashboard_instances SET record = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM dashboard_jobs WHERE id = ? AND status = 'queued')", encoded, item.id, item.revision, item.jobId),
      db.query("DELETE FROM dashboard_jobs WHERE id = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM dashboard_instances WHERE id = ? AND revision = ? AND record = ?)", item.jobId, item.id, item.revision + 1, encoded)
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) throw new ApiError(409, 'instance_busy');
    return view(item);
  }
  if (action === 'discard') {
    if (['queued', 'deploying', 'ready', 'suspended'].includes(item.status) || (item.status !== 'terminated' && Object.values(item.steps).includes('done'))) throw new ApiError(409, 'instance_deployed');
    await db.query('DELETE FROM dashboard_instances WHERE id = ? AND revision = ?', item.id, item.revision).run();
    return {discarded: true};
  }
  throw new ApiError(404, 'not_found');
}
export async function queueLifecycle(id, action, user, client, db) {
  if (!['suspend', 'resume', 'terminate'].includes(action)) throw new ApiError(400, 'invalid_action');
  let item;
  try {item = await db.find(id);} catch (error) {if (error.status !== 404) throw error;}
  if (item && ['queued', 'deploying'].includes(item.status)) throw new ApiError(409, 'instance_busy');
  if (!item) {
    const detail = await client.node('us', 'tenant', {id});
    item = {id, primary: detail.primary, secondary: detail.primary === 'us' ? 'de' : 'us', hostname: hostname(detail.url), status: detail.status, steps: {}, external: true, createdAt: new Date().toISOString(), createdBy: user};
    await db.insert(item);
  }
  item.operation = action;
  item.error = null;
  db.note(item, `${action} requested by ${user}.`);
  await db.enqueue(item, 'lifecycle', {action, user}, 'plan');
  return {id, status: 'queued', action};
}
