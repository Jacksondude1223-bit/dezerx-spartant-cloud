import path from 'node:path';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {validLicenseKey, productId} from '../node/license.mjs';
import {validInitialAdmin} from '../node/admin-validation.mjs';
import {issueDomainPermit} from '../node/domain-permit.mjs';

// Creates Spartan instances from the operator dashboard, following the "Create a
// service" flow in docs/API.md: provision the primary (with the first administrator),
// then the secondary, then publish the tenant as ready to the routing Worker.
//
// Without a customer domain, the routing Worker assigns instance-NNNN.<zone> as a Worker
// Custom Domain: one level under the zone, so Cloudflare's free certificate covers it.
// That hostname is the operator's, so the dashboard issues the node permit itself. A
// customer domain must first pass the routing Worker's onboarding checks (ownership
// TXT, Cloudflare hostname and certificate, Worker route), which issue the permit.
//
// Suspend, resume and terminate stay with whoever owns billing; this only creates.

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FIELD = /^[A-Za-z0-9_-]{1,100}$/;
const PRODUCTS = {SPARTANSTARTER_: 'Starter', SPARTANCLOUD_: 'Cloud', SPARTANCLOUDPLUS_: 'Cloud Plus', SPARTANPROFESSIONAL_: 'Professional', SPARTANULTIMATE_: 'Ultimate', SPARTANDEV_: 'Developer'};
const LOCAL_TIMEOUT = 15 * 60000;
// Cloudflare ends a proxied request after 100 seconds; the node carries on regardless.
const REMOTE_TIMEOUT = 110000;
const DEPLOY_WAIT = 20 * 60000;

export class ProvisionError extends Error { constructor(status, code) { super(code); this.status = status; } }

export const productName = key => PRODUCTS[Object.keys(PRODUCTS).find(prefix => String(key).startsWith(prefix))] || null;

export function loadProvisioningConfig(env, adminSecret) {
  const originSecret = env.ORIGIN_SECRET || '';
  if (!originSecret) return null;
  if (originSecret.length < 32 || /[\x00-\x20\x7f]/.test(originSecret)) throw new Error('ORIGIN_SECRET must be at least 32 characters (the same value as on the nodes)');
  if (originSecret === adminSecret) throw new Error('ORIGIN_SECRET must differ from ADMIN_API_SECRET');
  const baseDomain = String(env.BASE_DOMAIN || '').toLowerCase();
  if (!HOSTNAME.test(baseDomain)) throw new Error('BASE_DOMAIN is required with ORIGIN_SECRET (the tenant base domain, e.g. load.dezerx.cloud)');
  const routingUrl = new URL(env.ROUTING_API_URL || `https://${baseDomain}`);
  if (routingUrl.protocol !== 'https:') throw new Error('ROUTING_API_URL must use https');
  const stateFile = env.DASHBOARD_STATE_FILE || path.join(env.STATE_DIRECTORY || '/var/lib/spartan-dashboard', 'instances.json');
  // Legacy per-plane overrides, as on the nodes and the routing Worker. Permits always use ORIGIN_SECRET.
  // Only shown in the form; the routing Worker decides the real name.
  const instanceDomain = String(env.INSTANCE_DOMAIN || baseDomain.split('.').slice(1).join('.') || baseDomain).toLowerCase();
  return {originSecret, instanceDomain, controlSecret: env.NODE_CONTROL_SECRET || originSecret, routingSecret: env.ROUTING_CONTROL_SECRET || originSecret, baseDomain, routingUrl: routingUrl.origin, stateFile};
}

// Accepts "panel.example.com", "https://panel.example.com/" and the like.
export function normalizeDomain(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.$/, '');
  return HOSTNAME.test(text) && text.length <= 200 ? text : null;
}

export function createProvisioner(config, {nodes, now = Date.now, fetchImpl = fetch, record = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const p = config.provisioning;
  const instances = new Map();
  const permits = new Map();
  const running = new Map();
  let loaded = null;
  const reserved = [p.baseDomain, ...Object.values(nodes).map(origin => new URL(origin).hostname)];

  async function load() {
    if (!loaded) loaded = (async () => {
      try {
        const data = JSON.parse(await readFile(p.stateFile, 'utf8'));
        for (const item of Array.isArray(data.instances) ? data.instances : []) instances.set(item.id, item);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // A deployment cannot survive a restart: it needs the administrator password,
      // which is never written to disk.
      for (const item of instances.values()) if (item.status === 'deploying') Object.assign(item, {status: 'failed', error: 'dashboard_restarted'});
    })();
    return loaded;
  }
  let writing = Promise.resolve();
  function persist() {
    writing = writing.catch(() => {}).then(async () => {
      await mkdir(path.dirname(p.stateFile), {recursive: true, mode: 0o700});
      const temp = `${p.stateFile}.${randomBytes(6).toString('hex')}`;
      await writeFile(temp, JSON.stringify({instances: [...instances.values()]}, null, 2), {mode: 0o600});
      await rename(temp, p.stateFile);
    });
    return writing;
  }
  const update = async (item, fields) => { Object.assign(item, fields, {updatedAt: new Date(now()).toISOString()}); await persist(); };

  const signed = (secret, pathname, body) => {
    const timestamp = String(now());
    return {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': createHmac('sha256', secret).update(`${timestamp}\nPOST\n${pathname}\n${body}`).digest('hex'), 'user-agent': 'spartan-dashboard'};
  };
  async function call(origin, pathname, payload, timeout, secret) {
    const body = JSON.stringify(payload);
    let response;
    try { response = await fetchImpl(origin + pathname, {method: 'POST', headers: signed(secret, pathname, body), body, redirect: 'manual', signal: AbortSignal.timeout(timeout)}); }
    catch (error) { throw new ProvisionError(error?.name === 'TimeoutError' ? 504 : 502, error?.name === 'TimeoutError' ? 'node_timeout' : 'node_unreachable'); }
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (response.status === 524) throw new ProvisionError(504, 'still_running_on_node');
    if (!data) throw new ProvisionError(502, response.status === 403 ? 'blocked_by_cloudflare' : 'invalid_response');
    return {status: response.status, data};
  }
  const routing = async (action, payload) => call(p.routingUrl, `/v1/routing/${action}`, payload, 30000, p.routingSecret);

  const isLocal = region => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(nodes[region]).hostname);
  async function provisionOn(region, body) {
    const result = await call(nodes[region], '/control/provision', body, isLocal(region) ? LOCAL_TIMEOUT : REMOTE_TIMEOUT, p.controlSecret);
    if (result.status !== 200) throw new ProvisionError(result.status, String(result.data.error || 'node_error').slice(0, 80));
    return result.data;
  }

  // What the browser sees: never the app key, fingerprint, full licence or permit.
  const view = item => ({
    id: item.id, primary: item.primary, secondary: item.secondary, hostname: item.hostname, custom: item.custom, url: `https://${item.hostname}`,
    product: item.licenseKey ? productName(item.licenseKey) : null, licenseHint: item.licenseKey ? `${item.licenseKey.slice(0, item.licenseKey.indexOf('_') + 1)}…${item.licenseKey.slice(-4)}` : null,
    customerId: item.customerId, serviceId: item.serviceId, status: item.status, error: item.error || null, steps: item.steps || {},
    dns: item.dns || null, createdAt: item.createdAt, updatedAt: item.updatedAt, createdBy: item.createdBy
  });
  const other = region => region === 'us' ? 'de' : 'us';
  const find = async id => { await load(); const item = instances.get(id); if (!item) throw new ProvisionError(404, 'instance_not_found'); return item; };
  const dnsView = data => ({stage: data.stage, readyToProvision: data.readyToProvision === true, records: Array.isArray(data.dnsRecords) ? data.dnsRecords : [], status: data.status, certificateStatus: data.ssl?.status || data.certificateStatus || null, checkedAt: new Date(now()).toISOString()});
  const onboarding = item => ({id: item.id, serviceId: item.serviceId, customerId: item.customerId, primary: item.primary, hostname: item.hostname});

  const routingError = result => new ProvisionError(result.status === 401 ? 502 : result.status >= 400 ? result.status : 502, result.status === 401 ? 'routing_unauthorized' : String(result.data.error || 'routing_error').slice(0, 80));

  async function list() {
    await load();
    return [...instances.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(view);
  }

  async function create(input, user) {
    await load();
    const primary = input.primary;
    if (!['us', 'de'].includes(primary) || !nodes[primary]) throw new ProvisionError(400, 'invalid_region');
    if (!nodes[other(primary)]) throw new ProvisionError(400, 'both_nodes_required');
    // A licence is issued for one hostname. An assigned hostname is only known after
    // create, so its licence can come with the deploy instead.
    const licenseKey = typeof input.licenseKey === 'string' && input.licenseKey.trim() ? input.licenseKey.trim() : null;
    if ((licenseKey || input.domain) && !validLicenseKey(licenseKey)) throw new ProvisionError(400, 'invalid_license_key');
    const customerId = input.customerId ? String(input.customerId).trim() : 'dashboard';
    if (!FIELD.test(customerId)) throw new ProvisionError(400, 'invalid_customer_id');
    let hostname = null;
    if (input.domain) {
      hostname = normalizeDomain(input.domain);
      if (!hostname) throw new ProvisionError(400, 'invalid_domain');
      if (reserved.some(name => hostname === name || hostname.endsWith(`.${name}`))) throw new ProvisionError(400, 'reserved_hostname');
      if ([...instances.values()].some(item => item.hostname === hostname && item.status !== 'failed')) throw new ProvisionError(409, 'hostname_in_use');
    }
    // Same identity recipe as docs/API.md, so the optional provisioning Worker would derive the same tenant ID.
    const serviceId = `dash_${randomBytes(10).toString('hex')}`;
    const id = 't-' + createHash('sha256').update(serviceId).digest('hex').slice(0, 24);
    const item = {
      id, serviceId, customerId, primary, secondary: other(primary), licenseKey, hostname, custom: Boolean(hostname),
      appKey: 'base64:' + randomBytes(32).toString('base64'), fingerprint: createHash('sha256').update(JSON.stringify([serviceId, customerId, primary])).digest('hex'),
      lifecycleVersion: 0, status: hostname ? 'awaiting_dns' : 'ready_to_deploy', steps: {}, createdBy: user, createdAt: new Date(now()).toISOString()
    };
    if (hostname) {
      const result = await routing('onboarding/prepare', onboarding(item));
      if (result.status >= 400 && !result.data.hostname) throw new ProvisionError(result.status === 401 ? 502 : result.status, result.status === 401 ? 'routing_unauthorized' : String(result.data.error || 'routing_error').slice(0, 80));
      item.dns = dnsView(result.data);
    } else {
      // The hostname API needs the routing record, so register it as pending first.
      const pending = await routing('instances', {id, serviceId, customerId, primary, status: 'pending', lifecycleVersion: 0});
      if (pending.status !== 200 && pending.status !== 201) throw routingError(pending);
      let assigned = await routing(`instances/${id}/hostname`, {});
      if (assigned.status === 503 && assigned.data.retryable) assigned = await routing(`instances/${id}/hostname`, {});
      if (assigned.status !== 200 || !normalizeDomain(assigned.data.hostname)) throw routingError(assigned);
      item.hostname = normalizeDomain(assigned.data.hostname);
    }
    instances.set(id, item);
    await update(item, {});
    record('instance_create', {user, region: primary, id, path: item.hostname});
    return view(item);
  }

  // Fresh DNS, Cloudflare and route checks. A successful check returns a ten-minute permit.
  async function verify(id) {
    const item = await find(id);
    if (!item.custom) return view(item);
    if (!['awaiting_dns', 'ready_to_deploy', 'failed'].includes(item.status)) throw new ProvisionError(409, 'instance_busy');
    const result = await routing('onboarding/verify', onboarding(item));
    if (result.status === 401) throw new ProvisionError(502, 'routing_unauthorized');
    if (!result.data.hostname) throw new ProvisionError(result.status >= 400 ? result.status : 502, String(result.data.error || 'routing_error').slice(0, 80));
    const dns = dnsView(result.data);
    if (dns.readyToProvision && result.data.domainVerificationToken) permits.set(id, {token: result.data.domainVerificationToken, expiresAt: Date.parse(result.data.tokenExpiresAt) || now() + 540000});
    await update(item, {dns, ...(item.status === 'failed' ? {} : {status: dns.readyToProvision ? 'ready_to_deploy' : 'awaiting_dns'}), ...(dns.readyToProvision ? {} : {error: result.data.error || null})});
    return view(item);
  }

  async function permit(item) {
    if (!item.custom) return (await issueDomainPermit(p.originSecret, item.id, item.hostname, now())).token;
    const cached = permits.get(item.id);
    if (cached && cached.expiresAt - now() > 120000) return cached.token;
    permits.delete(item.id);
    await verify(item.id);
    const fresh = permits.get(item.id);
    if (!fresh) throw new ProvisionError(409, 'domain_not_verified');
    return fresh.token;
  }

  async function deployOn(item, role, admin) {
    const region = role === 'primary' ? item.primary : item.secondary;
    item.steps[role] = 'running';
    await persist();
    // A first boot runs migrations and seeders, which can take several minutes; each node
    // call only waits about 30 s for health, so keep asking until the deadline.
    const deadline = now() + DEPLOY_WAIT;
    const exhausted = attempt => attempt >= 60 || now() >= deadline;
    for (let attempt = 1; ; attempt++) {
      const body = {id: item.id, primary: item.primary, appKey: item.appKey, url: `https://${item.hostname}`, fingerprint: item.fingerprint, licenseKey: item.licenseKey, lifecycleVersion: item.lifecycleVersion, domainVerificationToken: await permit(item), ...(role === 'primary' ? {initialAdmin: admin} : {})};
      try {
        const result = await provisionOn(region, body);
        if (result.status === 'ready') { item.steps[role] = 'done'; await persist(); return; }
      } catch (error) {
        // Timeouts and gateway errors mean the node is still working; the retry joins its queue.
        const transient = error instanceof ProvisionError && (error.status >= 500 || error.status === 429 || error.message === 'domain_verification_required');
        if (error.message === 'domain_verification_required') permits.delete(item.id);
        if (!transient || exhausted(attempt)) { item.steps[role] = 'failed'; throw error; }
      }
      if (exhausted(attempt)) { item.steps[role] = 'failed'; throw new ProvisionError(504, 'not_ready_in_time'); }
      await sleep(Math.min(5000 * attempt, 20000));
    }
  }

  async function run(item, admin) {
    try {
      if (item.steps.primary !== 'done') await deployOn(item, 'primary', admin);
      if (item.steps.secondary !== 'done') await deployOn(item, 'secondary');
      item.steps.routing = 'running';
      await persist();
      // Onboarding registered the custom-domain service as pending at version 0, so ready needs 1.
      const result = await routing('instances', {id: item.id, serviceId: item.serviceId, customerId: item.customerId, primary: item.primary, status: 'ready', lifecycleVersion: 1});
      if (result.status !== 200 && result.status !== 201) { item.steps.routing = 'failed'; throw new ProvisionError(result.status, String(result.data.error || 'routing_error').slice(0, 80)); }
      item.steps.routing = 'done';
      await update(item, {status: 'ready', error: null, readyAt: new Date(now()).toISOString()});
      record('instance_ready', {region: item.primary, id: item.id});
    } catch (error) {
      await update(item, {status: 'failed', error: String(error?.message || 'deploy_failed').slice(0, 80)});
      record('instance_failed', {region: item.primary, id: item.id, path: item.error});
    } finally { running.delete(item.id); }
  }

  async function deploy(id, input, user) {
    const item = await find(id);
    if (running.has(id)) throw new ProvisionError(409, 'instance_busy');
    if (item.status === 'ready') throw new ProvisionError(409, 'already_deployed');
    if (item.status === 'awaiting_dns') throw new ProvisionError(409, 'domain_not_verified');
    const admin = input.initialAdmin;
    if (!validInitialAdmin(admin)) throw new ProvisionError(400, 'invalid_initial_admin');
    const licenseKey = typeof input.licenseKey === 'string' && input.licenseKey.trim() ? input.licenseKey.trim() : item.licenseKey;
    if (!validLicenseKey(licenseKey)) throw new ProvisionError(400, item.licenseKey ? 'invalid_license_key' : 'license_key_required');
    // Once a node holds the tenant, its licence changes only through the master website's domain flow.
    if (licenseKey !== item.licenseKey && (item.steps?.primary === 'done' || item.steps?.secondary === 'done')) throw new ProvisionError(409, 'license_locked');
    await update(item, {licenseKey, status: 'deploying', error: null});
    record('instance_deploy', {user, region: item.primary, id});
    running.set(id, run(item, {displayName: admin.displayName, email: admin.email, password: admin.password}));
    return view(item);
  }

  async function discard(id, user) {
    const item = await find(id);
    if (running.has(id) || item.status === 'deploying') throw new ProvisionError(409, 'instance_busy');
    if (item.status === 'ready' || item.steps?.primary === 'done' || item.steps?.secondary === 'done') throw new ProvisionError(409, 'instance_deployed');
    instances.delete(id);
    permits.delete(id);
    await persist();
    record('instance_discard', {user, region: item.primary, id});
    return {discarded: true};
  }

  return {list, create, verify, deploy, discard, get: async id => view(await find(id)), idle: () => Promise.all([...running.values()]), products: PRODUCTS};
}
