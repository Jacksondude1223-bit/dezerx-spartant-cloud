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
  // A deployment waits in the queue until both nodes have this much headroom.
  const minFreeMemory = Number(env.DASHBOARD_MIN_FREE_MEMORY_MB || 1024) * 1024 * 1024;
  const minFreeDisk = Number(env.DASHBOARD_MIN_FREE_DISK_GB || 5) * 1024 * 1024 * 1024;
  if (!(minFreeMemory >= 0) || !(minFreeDisk >= 0)) throw new Error('DASHBOARD_MIN_FREE_MEMORY_MB and DASHBOARD_MIN_FREE_DISK_GB must be numbers');
  return {originSecret, instanceDomain, minFreeMemory, minFreeDisk, controlSecret: env.NODE_CONTROL_SECRET || originSecret, routingSecret: env.ROUTING_CONTROL_SECRET || originSecret, baseDomain, routingUrl: routingUrl.origin, stateFile};
}

// Accepts "panel.example.com", "https://panel.example.com/" and the like.
export function normalizeDomain(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.$/, '');
  return HOSTNAME.test(text) && text.length <= 200 ? text : null;
}

export function createProvisioner(config, {nodes, now = Date.now, fetchImpl = fetch, record = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), nodeStatus = null, adminCall = null, queueInterval = 60000}) {
  const p = config.provisioning;
  const instances = new Map();
  const permits = new Map();
  const running = new Map();
  // Deployments waiting for room, oldest first. The administrator password stays in
  // memory only, so a restart drops the queue (those instances show dashboard_restarted).
  const queue = [];
  const queuedAdmins = new Map();
  let pumping = null;
  let timer = null;
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
      for (const item of instances.values()) {
        if (item.status === 'deploying' || item.status === 'queued') Object.assign(item, {status: 'failed', error: 'dashboard_restarted', progress: null, queue: null});
        // Records from earlier releases could fail with a step still marked running.
        if (item.status === 'failed') for (const key of Object.keys(item.steps || {})) if (item.steps[key] === 'running') item.steps[key] = 'failed';
      }
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
  // A running commentary for the instance page, so a long first boot is not a mystery.
  const note = (item, text, tone = '') => {
    item.log = [...(item.log || []), {time: new Date(now()).toISOString(), text, tone}].slice(-60);
  };
  const update = async (item, fields) => { Object.assign(item, fields, {updatedAt: new Date(now()).toISOString()}); await persist(); };

  const signed = (secret, pathname, body) => {
    const timestamp = String(now());
    return {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': createHmac('sha256', secret).update(`${timestamp}\nPOST\n${pathname}\n${body}`).digest('hex'), 'user-agent': 'spartan-dashboard'};
  };
  async function call(origin, pathname, payload, timeout, secret, method = 'POST') {
    const body = method === 'GET' ? '' : JSON.stringify(payload);
    let response;
    const headers = signed(secret, pathname, body);
    if (method === 'GET') { delete headers['content-type']; headers['x-spartan-signature'] = createHmac('sha256', secret).update(`${headers['x-spartan-timestamp']}\nGET\n${pathname}\n`).digest('hex'); }
    try { response = await fetchImpl(origin + pathname, {method, headers, body: method === 'GET' ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(timeout)}); }
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
    dns: item.dns || null, log: item.log || [], progress: item.progress || null, queue: item.status === 'queued' ? {position: queue.indexOf(item.id) + 1, length: queue.length, reason: item.queue?.reason || null, since: item.queue?.since || null, checkedAt: item.queue?.checkedAt || null} : null, createdAt: item.createdAt, updatedAt: item.updatedAt, createdBy: item.createdBy
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
    note(item, hostname ? `Created by ${user}. Add the DNS records below, then verify.` : `Created by ${user}. The routing Worker assigned ${item.hostname}; Cloudflare manages its DNS and certificate.`);
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
    await checkDomain(item);
    return view(item);
  }
  // Also used mid-deployment to renew the ten-minute permit, so it never changes a
  // deploying instance's status.
  async function checkDomain(item) {
    const id = item.id;
    const result = await routing('onboarding/verify', onboarding(item));
    if (result.status === 401) throw new ProvisionError(502, 'routing_unauthorized');
    if (!result.data.hostname) throw new ProvisionError(result.status >= 400 ? result.status : 502, String(result.data.error || 'routing_error').slice(0, 80));
    const dns = dnsView(result.data);
    const STAGES = {spartan_ownership: 'waiting for the _spartan-verification TXT record', cloudflare_validation: 'ownership proven; Cloudflare is validating the hostname and issuing the SSL certificate', routing_setup: 'certificate active; attaching the Worker route', ready_to_provision: 'everything checks out, ready to deploy'};
    note(item, `DNS check: ${STAGES[dns.stage] || dns.stage || result.data.error || 'checked'}.`, dns.readyToProvision ? 'good' : '');
    if (dns.readyToProvision && result.data.domainVerificationToken) permits.set(id, {token: result.data.domainVerificationToken, expiresAt: Date.parse(result.data.tokenExpiresAt) || now() + 540000});
    const settled = ['failed', 'deploying'].includes(item.status);
    await update(item, {dns, ...(settled ? {} : {status: dns.readyToProvision ? 'ready_to_deploy' : 'awaiting_dns'}), ...(dns.readyToProvision || settled ? {} : {error: result.data.error || null})});
  }

  async function permit(item) {
    if (!item.custom) return (await issueDomainPermit(p.originSecret, item.id, item.hostname, now())).token;
    const cached = permits.get(item.id);
    if (cached && cached.expiresAt - now() > 120000) return cached.token;
    permits.delete(item.id);
    await checkDomain(item);
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
    const started = now();
    const deadline = started + DEPLOY_WAIT;
    const exhausted = attempt => attempt >= 60 || now() >= deadline;
    const label = `node-${region}`;
    note(item, role === 'primary' ? `Provisioning on ${label} (home): creating the database, pulling the image if needed, starting the container, then waiting for the app to answer.` : `Provisioning the standby on ${label}. It holds no data and forwards traffic to the home node.`);
    for (let attempt = 1; ; attempt++) {
      item.progress = {role, region, attempt, startedAt: new Date(started).toISOString(), callStartedAt: new Date(now()).toISOString(), retryAt: null, deadline: new Date(deadline).toISOString()};
      if (attempt > 1) note(item, `Asking ${label} again (attempt ${attempt}).`);
      await persist();
      let callStarted = now();
      const took = () => `${Math.round((now() - callStarted) / 1000)} s`;
      try {
        let token;
        try { token = await permit(item); }
        catch (error) { throw Object.assign(new ProvisionError(error.status === 409 ? 409 : 503, error.message), {permitStage: true}); }
        const body = {id: item.id, primary: item.primary, appKey: item.appKey, url: `https://${item.hostname}`, fingerprint: item.fingerprint, licenseKey: item.licenseKey, lifecycleVersion: item.lifecycleVersion, domainVerificationToken: token, ...(role === 'primary' ? {initialAdmin: admin} : {})};
        callStarted = now();
        const result = await provisionOn(region, body);
        if (result.status === 'ready') {
          note(item, role === 'primary' ? `${label} is ready after ${took()}; the app answers its health check and the first administrator exists.` : `${label} is ready after ${took()}.`, 'good');
          item.steps[role] = 'done'; item.progress = null; await persist(); return;
        }
        note(item, `${label} answered after ${took()}: the container is running but the app is not answering yet. A first start runs database migrations and seeders, which can take a few minutes.`);
      } catch (error) {
        // Timeouts and gateway errors mean the node is still working; the retry joins its queue.
        const transient = error instanceof ProvisionError && (error.status >= 500 || error.status === 429 || error.message === 'domain_verification_required');
        if (error.message === 'domain_verification_required') permits.delete(item.id);
        const why = error.permitStage ? `Renewing the domain permit with the routing Worker failed: ${error.message}.` : ({still_running_on_node: `Cloudflare closed the request after 100 s, but ${label} keeps working.`, node_timeout: `${label} did not answer within the request time; it keeps working.`, node_unreachable: `${label} could not be reached.`, domain_verification_required: `${label} refused the domain permit; getting a fresh one.`, rate_limited: `${label} is rate limiting; waiting.`}[error.message] || `${label} answered ${error.message}${error.message === 'operation_failed' ? ' (the exact cause is in the node log: journalctl -u spartan-agent | grep request_failed)' : ''}.`);
        if (error.message === 'node_capacity') { note(item, `${label} is at its tenant limit (MAX_TENANTS); back to the queue.`, 'warn'); item.steps[role] = undefined; item.progress = null; throw Object.assign(error, {requeue: true}); }
        if (!transient || exhausted(attempt)) { note(item, `${why} Stopping.`, 'bad'); item.steps[role] = 'failed'; item.progress = null; throw error; }
        note(item, why, 'warn');
      }
      if (exhausted(attempt)) { note(item, `${label} was not ready within ${Math.round(DEPLOY_WAIT / 60000)} minutes.`, 'bad'); item.steps[role] = 'failed'; item.progress = null; throw new ProvisionError(504, 'not_ready_in_time'); }
      const wait = Math.min(5000 * attempt, 20000);
      item.progress.retryAt = new Date(now() + wait).toISOString();
      await persist();
      await sleep(wait);
    }
  }

  async function run(item, admin) {
    try {
      if (item.steps.primary !== 'done') await deployOn(item, 'primary', admin);
      if (item.steps.secondary !== 'done') await deployOn(item, 'secondary');
      item.steps.routing = 'running';
      note(item, 'Both nodes are ready. Publishing the instance to the routing Worker so visitors reach it.');
      await persist();
      // Onboarding registered the custom-domain service as pending at version 0, so ready needs 1.
      const result = await routing('instances', {id: item.id, serviceId: item.serviceId, customerId: item.customerId, primary: item.primary, status: 'ready', lifecycleVersion: 1});
      if (result.status !== 200 && result.status !== 201) { item.steps.routing = 'failed'; throw new ProvisionError(result.status, String(result.data.error || 'routing_error').slice(0, 80)); }
      item.steps.routing = 'done';
      note(item, `Live at https://${item.hostname}.`, 'good');
      await update(item, {status: 'ready', error: null, readyAt: new Date(now()).toISOString()});
      record('instance_ready', {region: item.primary, id: item.id});
    } catch (error) {
      if (error.requeue && admin) {
        for (const key of Object.keys(item.steps)) if (item.steps[key] === undefined) delete item.steps[key];
        queuedAdmins.set(item.id, admin);
        if (!queue.includes(item.id)) queue.push(item.id);
        await update(item, {status: 'queued', progress: null, queue: {since: new Date(now()).toISOString(), reason: 'node_capacity'}});
        return;
      }
      if (item.steps.routing === 'running') { item.steps.routing = 'failed'; note(item, `The routing Worker answered ${error?.message}.`, 'bad'); }
      // Never leave a spinner on a step that is no longer running.
      for (const key of ['primary', 'secondary']) if (item.steps[key] === 'running') { item.steps[key] = 'failed'; note(item, `Stopped: ${error?.message || 'unexpected error'}.`, 'bad'); }
      await update(item, {status: 'failed', error: String(error?.message || 'deploy_failed').slice(0, 80), progress: null});
      record('instance_failed', {region: item.primary, id: item.id, path: item.error});
    } finally { running.delete(item.id); schedule(); }
  }

  // Capacity of one node, from the admin API overview. Null when it cannot be read.
  async function headroom(region) {
    if (!nodeStatus) return {ok: true};
    try {
      const data = await nodeStatus(region);
      const free = data?.node?.resources?.memory?.freeBytes;
      const disk = data?.node?.resources?.disk?.availableBytes;
      if (!Number.isFinite(free) || !Number.isFinite(disk)) return {ok: false, reason: `node-${region} did not report its free memory and disk`};
      const gib = value => `${(value / 1024 ** 3).toFixed(1)} GB`;
      if (free < p.minFreeMemory) return {ok: false, reason: `node-${region} has ${gib(free)} memory free; needs ${gib(p.minFreeMemory)}`};
      if (disk < p.minFreeDisk) return {ok: false, reason: `node-${region} has ${gib(disk)} disk free; needs ${gib(p.minFreeDisk)}`};
      return {ok: true};
    } catch (error) { return {ok: false, reason: `node-${region} is unreachable (${error.message})`}; }
  }
  const busyRegions = () => new Set([...running.keys()].flatMap(id => { const item = instances.get(id); return item ? [item.primary, item.secondary] : []; }));

  // Starts queued deployments in order. One deployment per node at a time, because a
  // first boot (migrations, seeders) is the heaviest thing a node does.
  async function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      for (const id of [...queue]) {
        const item = instances.get(id);
        if (!item || item.status !== 'queued') { queue.splice(queue.indexOf(id), 1); continue; }
        const busy = busyRegions();
        let reason = null;
        if (busy.has(item.primary) || busy.has(item.secondary)) reason = `waiting for another deployment on node-${busy.has(item.primary) ? item.primary : item.secondary} to finish`;
        else {
          for (const region of [item.primary, item.secondary]) {
            const room = await headroom(region);
            if (!room.ok) { reason = room.reason; break; }
          }
        }
        if (reason) {
          if (item.queue?.reason !== reason) note(item, `Queued: ${reason}.`, 'warn');
          await update(item, {queue: {...item.queue, reason, checkedAt: new Date(now()).toISOString()}});
          continue;
        }
        queue.splice(queue.indexOf(id), 1);
        const admin = queuedAdmins.get(id);
        queuedAdmins.delete(id);
        note(item, item.queue?.reason ? 'Room is available; starting.' : 'Both nodes have room; starting.');
        await update(item, {status: 'deploying', queue: null, error: null});
        running.set(id, run(item, admin));
      }
    })().finally(() => { pumping = null; });
    return pumping;
  }
  function schedule() {
    if (queue.length && !timer) { timer = setInterval(() => { pump().catch(() => {}); }, queueInterval); timer.unref?.(); }
    if (!queue.length && timer) { clearInterval(timer); timer = null; }
    if (queue.length) pump().catch(() => {});
  }

  async function deploy(id, input, user) {
    const item = await find(id);
    if (running.has(id) || item.status === 'queued') throw new ProvisionError(409, 'instance_busy');
    if (item.status === 'ready') throw new ProvisionError(409, 'already_deployed');
    if (item.status === 'awaiting_dns') throw new ProvisionError(409, 'domain_not_verified');
    const admin = input.initialAdmin;
    if (!validInitialAdmin(admin)) throw new ProvisionError(400, 'invalid_initial_admin');
    const licenseKey = typeof input.licenseKey === 'string' && input.licenseKey.trim() ? input.licenseKey.trim() : item.licenseKey;
    if (!validLicenseKey(licenseKey)) throw new ProvisionError(400, item.licenseKey ? 'invalid_license_key' : 'license_key_required');
    // Once a node holds the tenant, its licence changes only through the master website's domain flow.
    if (licenseKey !== item.licenseKey && (item.steps?.primary === 'done' || item.steps?.secondary === 'done')) throw new ProvisionError(409, 'license_locked');
    note(item, `Deployment requested by ${user}. Checking that both nodes have room.`);
    queuedAdmins.set(id, {displayName: admin.displayName, email: admin.email, password: admin.password});
    queue.push(id);
    await update(item, {licenseKey, status: 'queued', error: null, queue: {since: new Date(now()).toISOString(), reason: null}});
    record('instance_deploy', {user, region: item.primary, id});
    await pump();
    return view(item);
  }

  async function cancel(id, user) {
    const item = await find(id);
    if (item.status !== 'queued') throw new ProvisionError(409, 'not_queued');
    queue.splice(queue.indexOf(id), 1);
    queuedAdmins.delete(id);
    note(item, `Removed from the queue by ${user}.`);
    await update(item, {status: item.custom && !item.dns?.readyToProvision ? 'awaiting_dns' : 'ready_to_deploy', queue: null});
    schedule();
    return view(item);
  }

  async function discard(id, user) {
    const item = await find(id);
    if (running.has(id) || ['deploying', 'queued'].includes(item.status)) throw new ProvisionError(409, 'instance_busy');
    if (item.status !== 'terminated' && (['ready', 'suspended'].includes(item.status) || item.steps?.primary === 'done' || item.steps?.secondary === 'done')) throw new ProvisionError(409, 'instance_deployed');
    instances.delete(id);
    permits.delete(id);
    await persist();
    record('instance_discard', {user, region: item.primary, id});
    return {discarded: true};
  }

  // Suspend, resume and terminate any tenant on the nodes, created here or by the master
  // website. The next lifecycle version is one above the highest any party has seen (both
  // nodes, the routing Worker, this dashboard), so it never collides with a stale one; if
  // a master website also manages the tenant, it must read versions the same way.
  const busyLifecycle = new Set();
  async function lifecycle(id, action, user) {
    if (!['suspend', 'resume', 'terminate'].includes(action)) throw new ProvisionError(400, 'invalid_action');
    if (!/^t-[a-f0-9]{24}$/.test(id)) throw new ProvisionError(400, 'invalid_id');
    if (!nodeStatus || !adminCall) throw new ProvisionError(503, 'provisioning_disabled');
    await load();
    if (busyLifecycle.has(id) || running.has(id)) throw new ProvisionError(409, 'instance_busy');
    busyLifecycle.add(id);
    const item = instances.get(id);
    const say = (text, tone) => { if (item) note(item, text, tone); };
    try {
      const copies = [];
      for (const region of Object.keys(nodes)) {
        let data;
        try { data = await nodeStatus(region); } catch { throw new ProvisionError(502, `node_${region}_unreachable`); }
        const copy = (data?.tenants || []).find(t => t.id === id);
        if (copy) copies.push({region, ...copy});
      }
      if (!copies.length) throw new ProvisionError(404, 'tenant_not_found');
      const fingerprint = copies[0].fingerprint;
      if (!/^[a-f0-9]{64}$/.test(fingerprint || '') || copies.some(c => c.fingerprint !== fingerprint)) throw new ProvisionError(409, 'tenant_conflict');
      const route = await call(p.routingUrl, `/v1/routing/instances/${id}`, null, 30000, p.routingSecret, 'GET');
      if (route.status === 401) throw new ProvisionError(502, 'routing_unauthorized');
      const routed = route.status === 200 ? route.data : null;
      const current = copies.find(c => c.role === 'primary')?.status || routed?.status;
      if (action === 'suspend' && current === 'suspended') throw new ProvisionError(409, 'already_suspended');
      if (action === 'resume' && current !== 'suspended') throw new ProvisionError(409, 'not_suspended');
      const version = Math.max(0, ...copies.map(c => c.lifecycleVersion || 0), routed?.lifecycleVersion || 0, item?.lifecycleVersion || 0, item?.status === 'ready' ? 1 : 0) + 1;
      const publish = async status => {
        if (!routed) return;
        const result = await routing('instances', {id, serviceId: routed.serviceId, customerId: routed.customerId, primary: routed.primary, status, lifecycleVersion: version});
        if (result.status !== 200 && result.status !== 201) throw routingError(result);
      };
      const onNodes = async body => {
        for (const copy of copies) {
          const result = await call(nodes[copy.region], '/control/lifecycle', body, isLocal(copy.region) ? LOCAL_TIMEOUT : REMOTE_TIMEOUT, p.controlSecret);
          if (result.status !== 200) throw new ProvisionError(result.status, `node_${copy.region}_${String(result.data.error || 'error').slice(0, 60)}`);
        }
      };
      say(`${{suspend: 'Suspending', resume: 'Resuming', terminate: 'Terminating'}[action]} (lifecycle version ${version}), requested by ${user}.`);
      if (action === 'suspend') {
        // Router first, so visitors get the suspended page before containers stop.
        await publish('suspended');
        await onNodes({id, fingerprint, lifecycleVersion: version, action: 'suspended'});
      } else if (action === 'resume') {
        // Primary first, so the database owner is up before the standby and the router.
        for (const copy of [...copies].sort((a, b) => (a.role === 'primary' ? -1 : 1) - (b.role === 'primary' ? -1 : 1))) {
          const result = await adminCall(copy.region, 'resume', {id, lifecycleVersion: version}, {timeout: isLocal(copy.region) ? LOCAL_TIMEOUT : REMOTE_TIMEOUT});
          if (result?.status !== 'ready') say(`node-${copy.region} is still starting; the router waits until it answers ready on a later resume.`, 'warn');
        }
        await publish('ready');
      } else {
        // The domain API only works on a ready tenant, so detach a customer domain first.
        if (item?.custom && routed?.status === 'ready') {
          const detached = await routing(`instances/${id}/domains/delete`, {hostname: item.hostname});
          if (detached.status >= 400 && detached.status !== 404) throw routingError(detached);
        }
        await publish('terminated');
        await onNodes({id, fingerprint, lifecycleVersion: version, action: 'terminated'});
      }
      const status = {suspend: 'suspended', resume: 'ready', terminate: 'terminated'}[action];
      if (item) { say({suspend: 'Suspended. Visitors see the suspended page; data is kept.', resume: 'Resumed and live again.', terminate: 'Terminated. Containers are removed; the database, storage and backups stay on the nodes.'}[action], action === 'resume' ? 'good' : ''); await update(item, {status, lifecycleVersion: version, error: null}); }
      record(`tenant_${action}`, {user, region: copies[0].region, id});
      return {id, status, lifecycleVersion: version};
    } catch (error) {
      if (item) { say(`${action} failed: ${error.message}.`, 'bad'); await persist(); }
      throw error;
    } finally { busyLifecycle.delete(id); }
  }

  // Resolves when nothing is running; queued work that cannot start yet does not hold it.
  const idle = async () => { while (running.size || pumping) { await Promise.all([...running.values(), pumping]); } };
  return {list, create, verify, deploy, cancel, discard, pump, lifecycle, get: async id => view(await find(id)), idle, products: PRODUCTS};
}
