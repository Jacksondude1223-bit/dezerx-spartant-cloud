import http from 'node:http';
import {existsSync} from 'node:fs';
import {createSecurity, sensitivePath} from './security.mjs';
import {isIP} from 'node:net';
import {applyLifecycle} from './service-lifecycle.mjs';
import {proxyHeaders} from './client-ip.mjs';
import https from 'node:https';
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, rename, chmod, readdir} from 'node:fs/promises';
import path from 'node:path';
import {createInitialAdmin, validInitialAdmin} from './initial-admin.mjs';
import {createRecovery} from './recovery.mjs';
import {createMysql, newPassword, SOCKET} from './mysql.mjs';
import {verifyDomainPermit} from './domain-permit.mjs';
import {productId, validLicenseKey} from './license.mjs';
import {appUrl} from './app-url.mjs';
import {createManagement, validImage, apiError} from './management.mjs';
import {createAdmin} from './admin.mjs';
import {proxyCacheControl} from './cache-policy.mjs';
import {cacheEnvironment, imageSupportsRedis, switchCacheEnvironment} from './tenant-env.mjs';
import {cpuSummary, requestedCpuLimit, tenantCpus} from './resources.mjs';
import {centralDatabase, validateDatabaseMode, databaseEnvironment, localTenant, remoteDatabaseReady, primaryConnection, DE_DATABASE_IP, US_DATABASE_IP} from './central-database.mjs';
import {networkPublicKey} from './network-key.mjs';

const run = promisify(execFile);
const cfg = {...process.env, NODE_CONTROL_SECRET: process.env.NODE_CONTROL_SECRET || process.env.ORIGIN_SECRET};
for (const key of ['NODE_REGION', 'NODE_CONTROL_SECRET', 'ORIGIN_SECRET', 'BASE_DOMAIN', 'SPARTAN_IMAGE', 'US_ORIGIN', 'DE_ORIGIN']) {
  if (!cfg[key] || cfg[key].includes('CHANGE_ME')) throw new Error(`missing_${key}`);
}
if (cfg.DOMAIN_VERIFICATION_REQUIRED !== undefined && !['true', 'false'].includes(cfg.DOMAIN_VERIFICATION_REQUIRED)) throw new Error('invalid_domain_verification_setting');
if (!['us', 'de'].includes(cfg.NODE_REGION)) throw new Error('invalid_region');
if (!/^\S+@sha256:[a-f0-9]{64}$/.test(cfg.SPARTAN_IMAGE)) throw new Error('image_digest_required');
if (cfg.NODE_CONTROL_SECRET.length < 32 || cfg.ORIGIN_SECRET.length < 32) throw new Error('weak_secret');
for (const key of ['US_ORIGIN', 'DE_ORIGIN']) {
  if (new URL(cfg[key]).protocol !== 'https:') throw new Error('https_required');
  // The installer accepted "https://node-us.example.com/". Concatenating a request path
  // onto that produced "//tenant/...", which the other node then answered with 404.
  cfg[key] = new URL(cfg[key]).origin;
}
const adminSecret = (() => {
  const value = cfg.ADMIN_API_SECRET;
  if (!value) return null;
  if (value.length < 32 || value.includes('CHANGE_ME') || /[\x00-\x20\x7f]/.test(value)) {
    console.error(JSON.stringify({event: 'admin_api_disabled', reason: 'ADMIN_API_SECRET must be at least 32 characters without whitespace or placeholder values'}));
    return null;
  }
  return value;
})();
validateDatabaseMode(cfg);
const root = cfg.DATA_ROOT || '/srv/spartan-cloud';
const port = Number(cfg.AGENT_PORT || 8788);
// Opt-in: serve the operator dashboard (running on this host's loopback) at
// https://<node hostname>/panel/, so it shares the node's existing tunnel route.
const dashboardPort = (() => {
  const value = cfg.DASHBOARD_PROXY_PORT;
  if (!value) return null;
  const number = Number(value);
  if (!/^\d{4,5}$/.test(value) || number < 1024 || number > 65535 || number === port || number === 8789) {
    console.error(JSON.stringify({event: 'dashboard_proxy_disabled', reason: 'DASHBOARD_PROXY_PORT must be a free port between 1024 and 65535'}));
    return null;
  }
  return number;
})();
const DASHBOARD_PATH = '/panel';
const jobs = new Map();
const security = createSecurity();
let pendingControls = 0;
let shuttingDown = false;
const maintenance = () => shuttingDown || existsSync(cfg.NODE_MAINTENANCE_FILE || '/run/spartan-cloud/node-maintenance');
const socketPath = cfg.MYSQL_SOCKET || SOCKET;
const socketDirectory = path.dirname(socketPath);
const validId = id => /^t-[a-f0-9]{24}$/.test(id || '');
// Hostnames a tenant must never claim as its own: the control host and the node tunnels.
const reservedHostnames = [cfg.BASE_DOMAIN, new URL(cfg.US_ORIGIN).hostname, new URL(cfg.DE_ORIGIN).hostname];
const tenantAppUrl = value => appUrl(value, {baseDomain: cfg.BASE_DOMAIN, originHostnames: reservedHostnames});
const container = id => `spartan-${id}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const reply = (res, status, payload) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(payload)); };
const dockerEnvironment = {...process.env, DOCKER_CONFIG: cfg.DOCKER_CONFIG || '/etc/spartan-cloud/docker'};
const docker = async args => (await run('docker', args, {timeout: 120000, maxBuffer: 1024 * 1024, env: dockerEnvironment})).stdout.trim();
const recovery = createRecovery({config: cfg, root, docker: async args => {
  const result = await run('docker', args, {timeout: 20000, maxBuffer: 1024 * 1024, env: dockerEnvironment});
  return args[0] === 'logs' ? `${result.stdout}\n${result.stderr}` : result.stdout.trim();
}, run});
const mysql = centralDatabase(cfg) && cfg.NODE_REGION === 'de'
  ? {ready: () => remoteDatabaseReady(run), ensureTenant: (id, password, identity) => primaryConnection(cfg, {id, ...identity})}
  : createMysql({run, socket: socketPath, maxConnections: cfg.MYSQL_MAX_USER_CONNECTIONS || 20, ...(centralDatabase(cfg) ? {remoteClientHost: DE_DATABASE_IP} : {})});
const management = createManagement({cfg, root, load, save, docker, mysql, applicationHealth});
const admin = createAdmin({cfg, root, load, management, env: dockerEnvironment});
const adminSecurity = createSecurity({limit: 900});
const stateFile = id => path.join(root, id, 'state.json');
async function load(id) {
  if (!validId(id)) throw new Error('invalid_id');
  try { return JSON.parse(await readFile(stateFile(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(record) {
  const dest = stateFile(record.id);
  const temp = `${dest}.tmp`;
  await writeFile(temp, JSON.stringify(record), {mode: 0o600});
  await rename(temp, dest);
}
const portChecks = new Map();
async function refreshPort(id) {
  if (!validId(id)) return null;
  const inFlight = portChecks.get(id);
  if (inFlight) return inFlight;
  if (jobs.has(id)) return null;
  const check = (async () => {
    const record = await load(id);
    if (!record || !localTenant(cfg, record) || record.status !== 'ready') return null;
    let inspect;
    try { inspect = JSON.parse(await docker(['inspect', container(id)]))[0]; } catch { return null; }
    if (!inspect?.State?.Running || inspect.Config?.Labels?.['spartan.fingerprint'] !== record.fingerprint) return null;
    const assigned = Number(inspect.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort);
    if (!assigned) return null;
    const current = await load(id);
    if (!current || current.status !== 'ready' || current.fingerprint !== record.fingerprint) return assigned;
    if (current.port !== assigned) {
      await save({...current, port: assigned});
      console.error(JSON.stringify({event: 'tenant_port_resynced', id, port: assigned}));
    }
    return assigned;
  })().finally(() => portChecks.delete(id));
  portChecks.set(id, check);
  return check;
}
function runArgs({id, role, fingerprint, envFile, directory, image, cpus}) {
  return ['run', '-d', '--name', container(id), '--label', 'spartan.managed=true', '--label', `spartan.tenant=${id}`, '--label', `spartan.role=${role}`, '--label', `spartan.fingerprint=${fingerprint}`, '--restart', 'unless-stopped', '--cpus', cpus, '--memory', cfg.TENANT_MEMORY || '2g', '--memory-swap', cfg.TENANT_MEMORY || '2g', '--pids-limit', '256', '--security-opt', 'no-new-privileges:true', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--env-file', envFile, '-p', '127.0.0.1::8080', '--mount', `type=bind,src=${directory}/storage,dst=/var/www/html/storage`, ...(!(centralDatabase(cfg) && cfg.NODE_REGION === 'de') ? ['--mount', `type=bind,src=${socketDirectory},dst=${socketDirectory},readonly`] : []), image];
}
async function assignedPortOf(id) {
  const inspect = JSON.parse(await docker(['inspect', container(id)]))[0];
  const assigned = Number(inspect.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort);
  if (!assigned) throw new Error('missing_port');
  return assigned;
}
function applicationHealth(assignedPort, url) {
  return new Promise((resolve, reject) => {
    const request = http.get({hostname: '127.0.0.1', port: assignedPort, path: '/__cloud_health', headers: {host: new URL(url).hostname, 'x-forwarded-host': new URL(url).hostname, 'x-forwarded-proto': 'https', 'x-forwarded-port': '443'}, signal: AbortSignal.timeout(2000)}, response => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('error', reject);
  });
}
async function healthy(assignedPort, attempts, url) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (await applicationHealth(assignedPort, url)) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}
async function provisionOnce(input, progress) {
  progress.stage = 'prepare';
  const {id, primary, appKey, url, fingerprint, licenseKey} = input;
  const appUrlValue = tenantAppUrl(url);
  if (!validId(id) || !['us', 'de'].includes(primary) || !/^base64:[A-Za-z0-9+/]{43}=$/.test(appKey || '') || !appUrlValue || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new Error('invalid_input');
  const prior = validId(id) ? await load(id) : null;
  // The permit proves a hostname is verified before a tenant first uses it. Resuming or
  // re-provisioning on the URL the tenant already has needs no new proof; otherwise a
  // suspended tenant could never resume, because onboarding refuses suspended routes.
  const sameUrl = prior && tenantAppUrl(prior.url) === appUrlValue && input.domainVerificationToken === undefined;
  if ((cfg.DOMAIN_VERIFICATION_REQUIRED === 'true' && !sameUrl) || input.domainVerificationToken !== undefined) {
    if (!await verifyDomainPermit(input.domainVerificationToken, cfg.ORIGIN_SECRET, id, new URL(appUrlValue).hostname)) throw apiError('domain_verification_required', 409);
  }
  if (centralDatabase(cfg) && primary !== 'us') throw apiError('us_primary_required', 409);
  if (!validLicenseKey(licenseKey)) throw new Error('invalid_license_key');
  if (input.initialAdmin !== undefined && !validInitialAdmin(input.initialAdmin)) throw new Error('invalid_initial_admin');
  const {initialAdmin, domainVerificationToken, ...persistedInput} = input;
  persistedInput.url = appUrlValue;
  const existing = await load(id);
  persistedInput.adminInitialized = existing?.adminInitialized === true || existing?.status === 'ready';
  persistedInput.image = existing?.image || cfg.SPARTAN_IMAGE;
  // An override set through /admin/resources or /control/resources survives re-provisioning;
  // a provision request may also set one (null returns the tenant to the node default).
  const cpuLimit = Object.hasOwn(input, 'cpuLimit') ? requestedCpuLimit(input.cpuLimit) : existing?.cpuLimit;
  if (cpuLimit) persistedInput.cpuLimit = cpuLimit; else delete persistedInput.cpuLimit;
  const version = input.lifecycleVersion || 0;
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('invalid_input');
  if (existing?.status === 'terminated') throw new Error('service_terminated');
  if (version < (existing?.lifecycleVersion || 0) || existing?.status === 'suspended' && version <= (existing.lifecycleVersion || 0)) throw new Error('stale_operation');
  if (existing && (existing.fingerprint !== fingerprint || existing.appKey && existing.appKey !== appKey || existing.primary && existing.primary !== primary)) throw new Error('tenant_conflict');
  const directory = path.join(root, id);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const role = primary === cfg.NODE_REGION ? 'primary' : 'secondary';
  const storage = path.join(directory, 'storage');
  await mkdir(storage, {recursive: true, mode: 0o700});
  await run('chown', ['-R', '33:33', storage]);
  if (!await mysql.ready()) throw new Error('database_unavailable');
  // Node-owned: the password never travels over the control API, and ensureTenant
  // resyncs it so a lost state.json cannot orphan the database.
  const proposedPassword = existing?.dbPassword || newPassword();
  const connection = await mysql.ensureTenant(id, proposedPassword, {fingerprint});
  const dbPassword = connection.password || proposedPassword;
  persistedInput.dbPassword = dbPassword;
  persistedInput.databaseMode = centralDatabase(cfg) ? 'us-central' : 'local';
  const env = {APP_NAME: 'Spartan', APP_ENV: 'production', APP_DEBUG: 'false', OCTANE_SERVER: 'roadrunner', OCTANE_HTTPS: 'true', APP_KEY: appKey, APP_URL: appUrlValue, ASSET_URL: appUrlValue, LICENSE_KEY: licenseKey, PRODUCT_ID: productId(licenseKey), LOG_CHANNEL: 'stderr', ...databaseEnvironment(cfg, {...connection, password: dbPassword}, socketPath), ...cacheEnvironment({redis: await imageSupportsRedis(docker, persistedInput.image), databaseSessions: centralDatabase(cfg)}), SESSION_SECURE_COOKIE: 'true', SESSION_SAME_SITE: 'lax', QUEUE_CONNECTION: 'database', CLOUD_ROLE: role, TENANT_ID: id};
  const additional = cfg.LARAVEL_ENV_FILE ? JSON.parse(await readFile(cfg.LARAVEL_ENV_FILE, 'utf8')) : {};
  for (const [key, value] of Object.entries(additional)) {
    if (key in env || !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('invalid_laravel_env');
    env[key] = value;
  }
  const envFile = path.join(directory, 'app.env');
  await writeFile(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
  await chmod(envFile, 0o600);
  persistedInput.envHash = createHash('sha256').update(await readFile(envFile)).digest('hex');
  persistedInput.containerEnvHash = existing?.containerEnvHash;
  let inspect;
  try { inspect = JSON.parse(await docker(['inspect', container(id)]))[0]; }
  catch { inspect = null; }
  const runningUrl = inspect?.Config?.Env?.find(value => value.startsWith('APP_URL='))?.slice(8);
  persistedInput.containerDatabaseMode = inspect ? (inspect.Config?.Env?.includes('CLOUD_DATABASE_MODE=us-central') ? 'us-central' : 'local') : existing?.containerDatabaseMode || 'local';
  persistedInput.containerUrl = tenantAppUrl(runningUrl) || tenantAppUrl(existing?.containerUrl) || tenantAppUrl(existing?.url) || appUrlValue;
  // Re-provisioning a serving tenant only rewrites app.env — the container keeps running
  // on the old one until an upgrade recreates it. Taking the tenant out of 'ready' would
  // send its live traffic nowhere for the sake of a change that has not happened yet.
  const interim = existing?.status === 'ready' && inspect?.State?.Running ? 'ready' : 'provisioning';
  await save({...persistedInput, role, status: interim});
  if (!inspect) {
    const count = (await readdir(root)).filter(validId).length;
    if (count > Number(cfg.MAX_TENANTS || 100)) throw new Error('node_capacity');
    progress.stage = 'pull';
    await docker(['pull', persistedInput.image]);
    progress.stage = 'launch';
    await docker(runArgs({id, role, fingerprint, envFile, directory, image: persistedInput.image, cpus: tenantCpus(cfg, persistedInput)}));
    persistedInput.containerEnvHash = persistedInput.envHash;
    persistedInput.containerDatabaseMode = persistedInput.databaseMode;
    persistedInput.containerUrl = appUrlValue;
  } else {
    if (inspect.Config.Labels?.['spartan.fingerprint'] !== fingerprint) throw new Error('container_conflict');
    if (existing?.status === 'suspended') await docker(['update', '--restart=unless-stopped', container(id)]);
    if (tenantCpus(cfg, persistedInput) !== tenantCpus(cfg, existing)) await docker(['update', '--cpus', tenantCpus(cfg, persistedInput), container(id)]);
    if (!inspect.State.Running) { progress.stage = 'start'; await docker(['start', container(id)]); }
  }
  inspect = JSON.parse(await docker(['inspect', container(id)]))[0];
  const assignedPort = Number(inspect.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort);
  if (!assignedPort) throw new Error('missing_port');
  await save({...persistedInput, role, port: assignedPort, status: interim});
  progress.stage = 'health';
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const health = await applicationHealth(assignedPort, persistedInput.containerUrl);
      if (health) {
        if (role === 'primary' && initialAdmin && !persistedInput.adminInitialized) {
          progress.stage = 'initial_admin';
          await createInitialAdmin(id, initialAdmin);
          persistedInput.adminInitialized = true;
        }
        await save({...persistedInput, role, port: assignedPort, status: 'ready'});
        await recovery.success(id).catch(() => {});
        return {id, status: 'ready', role};
      }
    } catch (error) { if (progress.stage === 'initial_admin') throw error; }
    await sleep(1000);
  }
  return {id, status: 'provisioning', role};
}
const PERMANENT_PROVISION_ERRORS = {invalid_input: 422, invalid_cpu_limit: 422, invalid_license_key: 422, invalid_laravel_env: 422, invalid_initial_admin: 422, initial_admin_failed: 422, tenant_conflict: 409, container_conflict: 409, node_capacity: 409, domain_verification_required: 409, stale_operation: 409, service_terminated: 409};
async function provision(input) {
  const before = validId(input.id) ? await load(input.id) : null;
  const mayRecover = !before || before.status !== 'ready';
  const progress = {stage: 'prepare'};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await provisionOnce(input, progress);
      if (result.status === 'ready' || !mayRecover || attempt === 2) return result;
      if (!await recovery.recover(input.id, progress.stage, new Error('health_timeout'))) return result;
    } catch (error) {
      // Retrying these cannot help, so name them instead of the generic 503 operation_failed.
      if (Object.hasOwn(PERMANENT_PROVISION_ERRORS, error.message)) throw error.apiStatus ? error : apiError(error.message, PERMANENT_PROVISION_ERRORS[error.message]);
      if (!mayRecover || attempt === 2 || !await recovery.recover(input.id, progress.stage, error).catch(() => false)) throw error;
    }
  }
  throw new Error('recovery_exhausted');
}
async function upgrade(input) {
  const {id, fingerprint} = input;
  if (!validId(id) || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new Error('invalid_input');
  const record = await load(id);
  if (!record) throw new Error('not_provisioned');
  const targetImage = input.image === undefined ? cfg.SPARTAN_IMAGE : input.image;
  if (!validImage(targetImage)) throw apiError('image_digest_required');
  if (record.fingerprint !== fingerprint) throw new Error('tenant_conflict');
  if (record.status === 'terminated') throw new Error('service_terminated');
  if (record.status !== 'ready') throw new Error('service_not_ready');
  let inspect;
  try { inspect = JSON.parse(await docker(['inspect', container(id)]))[0]; } catch { throw new Error('not_provisioned'); }
  const labels = inspect.Config?.Labels || {};
  if (labels['spartan.fingerprint'] !== fingerprint || labels['spartan.tenant'] !== id || labels['spartan.managed'] !== 'true') throw new Error('container_conflict');
  const previousImage = inspect.Config?.Image || record.image;
  const staleEnvironment = !!record.envHash && record.envHash !== record.containerEnvHash;
  if (previousImage === targetImage && !staleEnvironment) return {id, status: 'current', image: previousImage, role: record.role};
  const changed = previousImage === targetImage ? 'environment' : staleEnvironment ? 'image_and_environment' : 'image';
  // Pull before touching the running container, so an unreachable or wrong digest fails
  // while the tenant is still serving.
  await docker(['pull', targetImage]);
  const directory = path.join(root, id);
  const envFile = path.join(directory, 'app.env');
  // Match the cache to the target image (see tenant-env.mjs). An image that starts Redis
  // before its migrations gets the Redis cache, once per tenant so a deliberate operator
  // change back to files is kept; an older image always gets the file cache, because a
  // Redis cache stops it at migrate.
  let legacyEnvironment = null;
  const redisReady = await imageSupportsRedis(docker, targetImage);
  if (!redisReady || !record.redisCacheMigrated) {
    const text = await readFile(envFile, 'utf8');
    const switched = switchCacheEnvironment(text, redisReady);
    if (switched.changed) {
      legacyEnvironment = {text, envHash: record.envHash, redisCacheMigrated: record.redisCacheMigrated};
      await writeFile(envFile, switched.text, {mode: 0o600});
      record.envHash = createHash('sha256').update(switched.text).digest('hex');
    }
    if (redisReady) record.redisCacheMigrated = true; else delete record.redisCacheMigrated;
  }
  await docker(['stop', '--time', '30', container(id)]);
  await docker(['rm', '--force', container(id)]);
  const create = async image => {
    await docker(runArgs({id, role: record.role, fingerprint, envFile, directory, image, cpus: tenantCpus(cfg, record)}));
    const assigned = await assignedPortOf(id);
    await save({...record, image, port: assigned, containerEnvHash: record.envHash, containerDatabaseMode: record.databaseMode || 'local', containerUrl: record.url, status: 'provisioning'});
    return assigned;
  };
  let assignedPort;
  try { assignedPort = await create(targetImage); }
  catch (error) {
    // The replacement never started, so its entrypoint never reached migrate and the
    // previous image is still safe to put back.
    const reason = String(error.message).slice(0, 100);
    let failed;
    try { failed = JSON.parse(await docker(['inspect', container(id)]))[0]; }
    catch (inspectError) {
      if (!/No such (object|container)/i.test(String(inspectError.stderr || inspectError.message))) throw new Error('upgrade_failed');
    }
    if (failed) {
      const labels = failed.Config?.Labels || {};
      if (labels['spartan.managed'] !== 'true' || labels['spartan.tenant'] !== id || labels['spartan.fingerprint'] !== fingerprint) throw new Error('container_conflict');
      if (failed.State?.Running || failed.State?.StartedAt && !failed.State.StartedAt.startsWith('0001-')) {
        await save({...record, image: targetImage, status: 'provisioning', port: Number(failed.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort) || record.port});
        return {id, status: 'provisioning', previousImage, image: targetImage, role: record.role};
      }
      await docker(['rm', '--force', container(id)]);
    }
    // The previous image goes back to the environment it ran with; the next upgrade
    // switches the cache again.
    if (legacyEnvironment) {
      await writeFile(envFile, legacyEnvironment.text, {mode: 0o600});
      record.envHash = legacyEnvironment.envHash;
      if (legacyEnvironment.redisCacheMigrated) record.redisCacheMigrated = true; else delete record.redisCacheMigrated;
    }
    try {
      const restoredPort = await create(previousImage);
      if (await healthy(restoredPort, Number(cfg.UPGRADE_HEALTH_ATTEMPTS || 60), record.url)) await save({...await load(id), status: 'ready'});
    }
    catch { throw new Error('upgrade_failed'); }
    console.error(JSON.stringify({event: 'tenant_upgrade_rolled_back', id, reason}));
    return {id, status: 'rolled_back', image: previousImage, attempted: targetImage, reason, role: record.role};
  }
  if (await healthy(assignedPort, Number(cfg.UPGRADE_HEALTH_ATTEMPTS || 60), record.url)) {
    await save({...await load(id), status: 'ready'});
    await recovery.success(id).catch(() => {});
    console.error(JSON.stringify({event: 'tenant_upgraded', id, from: previousImage, to: targetImage}));
    return {id, status: 'upgraded', changed, previousImage, image: targetImage, role: record.role};
  }
  // It started, so migrations may already have applied. Rolling back now could leave the
  // schema ahead of the code, so report and let the operator decide.
  return {id, status: 'provisioning', previousImage, image: targetImage, role: record.role};
}
async function body(req, limit = 16384) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// Cheap checks that need no body. Rejecting here means an unauthenticated client can no
// longer make the agent buffer a multi-megabyte body before it is turned away.
function plausible(req) {
  const timestamp = req.headers['x-spartan-timestamp'];
  return req.method === 'POST' && /^\d+$/.test(timestamp || '') && Math.abs(Date.now() - Number(timestamp)) <= 300000 && /^[a-f0-9]{64}$/.test(req.headers['x-spartan-signature'] || '');
}
const signedWith = (secret, req, url, payload) => equal(createHmac('sha256', secret).update(`${req.headers['x-spartan-timestamp']}\n${req.method}\n${url.pathname}\n${payload}`).digest('hex'), req.headers['x-spartan-signature']);
function deny(res, limiter, unread = false) {
  const withinLimit = limiter.denied();
  res.writeHead(withinLimit ? 401 : 429, {'content-type': 'application/json', 'cache-control': 'no-store', ...(unread ? {connection: 'close'} : {})});
  res.end(JSON.stringify({error: withinLimit ? 'unauthorized' : 'rate_limited'}));
}
function parseInput(payload) {
  const input = JSON.parse(payload);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiError('invalid_input');
  return input;
}
async function reloadTenant(input) {
  const info = await management.information(input);
  if (!info.running || info.status !== 'ready') throw apiError('service_not_ready', 409);
  await docker(['exec', '--user', '33:33', container(input.id), 'php', 'artisan', 'optimize:clear', '--no-interaction']);
  await docker(['exec', '--user', '33:33', container(input.id), 'php', 'artisan', 'octane:reload', '--no-interaction']);
  return {id: input.id, reloaded: true};
}
// Changes one tenant's CPU limit. Docker applies it to the running container at once
// (no restart), and the record keeps it for every later recreation (upgrade, re-provision).
async function setCpuLimit(input) {
  const record = await load(input.id);
  if (!record) throw apiError('not_provisioned', 404);
  if (record.fingerprint !== input.fingerprint) throw apiError('tenant_conflict', 409);
  if (record.status === 'terminated') throw apiError('service_terminated', 410);
  if (!Object.hasOwn(input, 'cpuLimit')) throw apiError('invalid_cpu_limit', 422);
  const cpuLimit = requestedCpuLimit(input.cpuLimit);
  const next = {...record};
  if (cpuLimit) next.cpuLimit = cpuLimit; else delete next.cpuLimit;
  let exists = true;
  try { await docker(['inspect', '--type', 'container', '--format', '{{.Id}}', container(input.id)]); }
  catch (error) { if (/No such (?:object|container)/i.test(String(error.stderr || error.message))) exists = false; else throw error; }
  if (exists) {
    try { await docker(['update', '--cpus', tenantCpus(cfg, next), container(input.id)]); }
    catch (error) {
      // Docker refuses a limit above the host's CPU count; say so instead of a generic 503.
      if (/range of CPUs/i.test(String(error.stderr || error.message))) throw apiError('cpu_limit_exceeds_host', 422);
      throw error;
    }
  }
  await save(next);
  security.audit('tenant_cpu_limit', {id: input.id, cpuLimit: tenantCpus(cfg, next)});
  return {id: input.id, ...cpuSummary(cfg, next), applied: exists};
}
// Docker-level power control for operators. Billing state (suspend, terminate, resume)
// stays with the master website through /control/lifecycle and /control/provision.
async function containerAction(input) {
  if (!['start', 'stop', 'restart'].includes(input.action)) throw apiError('invalid_action');
  const {record} = await management.tenant(input);
  if (input.action !== 'stop' && ['suspended', 'terminated'].includes(record.status)) throw apiError('service_suspended', 409);
  if (input.action === 'stop') await docker(['stop', '--time', '30', container(input.id)]);
  else await docker([input.action, ...(input.action === 'restart' ? ['--time', '30'] : []), container(input.id)]);
  // A restarted container can be given a different loopback port.
  const port = input.action === 'stop' ? null : await refreshPort(input.id).catch(() => null);
  security.audit('admin_container_action', {id: input.id});
  return {id: input.id, action: input.action, done: true, ...(port ? {port} : {})};
}
// Serialises work on one tenant with the control routes, so an operator restart cannot
// interleave with a provision or upgrade from the master website.
async function queued(id, task) {
  if (maintenance()) throw apiError('node_update_in_progress', 503);
  if (pendingControls >= 50) throw apiError('control_capacity', 429);
  pendingControls++;
  const previous = jobs.get(id) || Promise.resolve();
  const job = previous.catch(() => {}).then(task);
  jobs.set(id, job);
  try { return await job; }
  finally { pendingControls--; if (jobs.get(id) === job) jobs.delete(id); }
}
// Forwards /panel traffic to the local dashboard. Only the headers the dashboard needs
// are passed on; Cloudflare's cf-connecting-ip lets it rate-limit sign-ins per visitor.
function proxyDashboard(req, res, url) {
  const headers = {'x-forwarded-proto': 'https'};
  for (const key of ['cookie', 'content-type', 'content-length', 'x-csrf-token', 'accept', 'cf-connecting-ip', 'user-agent', 'if-none-match']) if (req.headers[key] !== undefined) headers[key] = req.headers[key];
  const upstream = http.request({hostname: '127.0.0.1', port: dashboardPort, method: req.method, path: url.pathname + url.search, headers}, response => {
    const out = {...response.headers};
    for (const key of ['connection', 'keep-alive', 'transfer-encoding']) delete out[key];
    res.writeHead(response.statusCode, out);
    response.pipe(res);
  });
  upstream.setTimeout(330000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => { if (!res.headersSent) reply(res, 502, {error: 'dashboard_unavailable'}); else res.destroy(); });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}
const ADMIN_ROUTES = ['/admin/ping', '/admin/overview', '/admin/tenants', '/admin/stats', '/admin/tenant', '/admin/logs', '/admin/exec', '/admin/fs', '/admin/fs/download', '/admin/container', '/admin/reload', '/admin/upgrade', '/admin/database/download', '/admin/resume', '/admin/resources'];
async function adminRoute(req, res, url) {
  if (!adminSecret || !ADMIN_ROUTES.includes(url.pathname)) return reply(res, 404, {error: 'not_found'});
  if (!plausible(req)) return deny(res, adminSecurity, true);
  const payload = await body(req, url.pathname === '/admin/fs' ? 8 * 1024 * 1024 + 65536 : 16384);
  if (!signedWith(adminSecret, req, url, payload)) return deny(res, adminSecurity);
  if (!adminSecurity.allowed()) return reply(res, 429, {error: 'rate_limited'});
  const input = parseInput(payload);
  const operation = url.pathname.slice('/admin/'.length);
  // Answers immediately so the dashboard can show real round-trip latency; overview
  // includes Docker's one-second CPU sample and is not a latency measure.
  if (operation === 'ping') return reply(res, 200, {ok: true, region: cfg.NODE_REGION});
  if (operation === 'overview') return reply(res, 200, await admin.overview());
  if (operation === 'tenants') return reply(res, 200, {region: cfg.NODE_REGION, tenants: await admin.tenants({withStats: input.stats === true})});
  if (operation === 'stats') return reply(res, 200, {region: cfg.NODE_REGION, containers: await admin.stats(), sampledAt: new Date().toISOString()});
  const record = await admin.record(input);
  const tenant = {...input, id: record.id, fingerprint: record.fingerprint};
  security.audit('admin_authorized', {id: record.id, operation: `admin/${operation}`, user: input.user, action: input.action});
  if (operation === 'tenant') return reply(res, 200, await admin.detail(tenant));
  if (operation === 'logs') return reply(res, 200, await admin.logs(tenant));
  if (operation === 'exec') return reply(res, 200, await admin.exec(tenant));
  if (operation === 'fs') return reply(res, 200, await admin.fs(input));
  if (operation === 'fs/download') return admin.download(input, res);
  if (operation === 'database/download') return management.sqlDownload(tenant, res);
  if (operation === 'container') return reply(res, 200, await queued(record.id, () => containerAction(tenant)));
  if (operation === 'reload') return reply(res, 200, await queued(record.id, () => reloadTenant(tenant)));
  if (operation === 'upgrade') return reply(res, 200, await queued(record.id, () => upgrade({id: record.id, fingerprint: record.fingerprint})));
  if (operation === 'resources') return reply(res, 200, await queued(record.id, () => setCpuLimit({id: record.id, fingerprint: record.fingerprint, ...(Object.hasOwn(input, 'cpuLimit') ? {cpuLimit: input.cpuLimit} : {})})));
  // Resumes a suspended tenant from the node's own record (app key, licence, URL), so the
  // dashboard can resume tenants the master website created. Same rules as a resume
  // through /control/provision: a newer lifecycle version, and never after termination.
  if (operation === 'resume') {
    if (!Number.isSafeInteger(input.lifecycleVersion) || input.lifecycleVersion < 1) throw apiError('invalid_lifecycle_version');
    if (record.status !== 'suspended') throw apiError(record.status === 'terminated' ? 'service_terminated' : 'not_suspended', 409);
    const {status, role, port, lifecycleAction, updatedAt, ...stored} = record;
    return reply(res, 200, await queued(record.id, () => provision({...stored, lifecycleVersion: input.lifecycleVersion})));
  }
  return reply(res, 404, {error: 'not_found'});
}
async function control(req, res, url) {
  if (!plausible(req)) return deny(res, security, true);
  const payload = await body(req, url.pathname === '/control/files' ? 6 * 1024 * 1024 + 16384 : 16384);
  if (!signedWith(cfg.NODE_CONTROL_SECRET, req, url, payload)) return deny(res, security);
  if (!security.allowed()) return reply(res, 429, {error: 'rate_limited'});
  if (!['/control/provision', '/control/lifecycle', '/control/upgrade', '/control/node-health', '/control/instance', '/control/health', '/control/version', '/control/database/download', '/control/files', '/control/domain', '/control/reload', '/control/list', '/control/database/connection', '/control/network/key', '/control/resources'].includes(url.pathname)) return reply(res, 404, {error: 'not_found'});
  const input = JSON.parse(payload);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(res, 400, {error: 'invalid_input'});
  if (url.pathname === '/control/network/key') {
    const result = await networkPublicKey(cfg.NODE_REGION);
    return result ? reply(res, 200, result) : reply(res, 503, {error: 'network_key_not_ready'});
  }
  if (url.pathname === '/control/node-health') return reply(res, 200, await management.nodeHealth());
  if (url.pathname === '/control/list') return reply(res, 200, {region: cfg.NODE_REGION, tenants: await admin.tenants()});
  if (!validId(input.id)) return reply(res, 400, {error: 'invalid_id'});
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint || '')) return reply(res, 400, {error: 'invalid_fingerprint'});
  if (maintenance()) return reply(res, 503, {error: 'node_update_in_progress'});
  if (pendingControls >= 50) return reply(res, 429, {error: 'control_capacity'});
  pendingControls++;
  const operation = url.pathname.slice('/control/'.length);
  security.audit('control_authorized', {id: input.id, operation});
  const previous = jobs.get(input.id) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    if (url.pathname === '/control/database/connection') {
      if (!centralDatabase(cfg) || cfg.NODE_REGION !== 'us') throw apiError('us_database_required', 409);
      const record = await load(input.id);
      if (!record || record.fingerprint !== input.fingerprint) throw apiError('tenant_conflict', 409);
      if (record.primary !== 'us' || record.role !== 'primary' || record.status !== 'ready' || !record.dbPassword) throw apiError('primary_not_ready', 409);
      if (!await mysql.ready()) throw apiError('database_unavailable', 503);
      const connection = await mysql.ensureTenant(record.id, record.dbPassword);
      return {id: record.id, host: US_DATABASE_IP, ...connection, password: record.dbPassword};
    }
    if (url.pathname === '/control/lifecycle') return applyLifecycle(input, {root, load, save, docker});
    if (url.pathname === '/control/upgrade') return upgrade(input);
    if (url.pathname === '/control/instance') return management.information(input);
    if (url.pathname === '/control/health') return management.information(input, true);
    if (url.pathname === '/control/version') return management.version(input);
    if (url.pathname === '/control/files') return management.files(input);
    if (url.pathname === '/control/database/download') {await management.sqlDownload(input, res); return null;}
    if (url.pathname === '/control/domain') {
      const record = await load(input.id);
      if (!record) throw apiError('not_provisioned', 404);
      if (record.fingerprint !== input.fingerprint) throw apiError('tenant_conflict', 409);
      if (record.status !== 'ready') throw apiError('service_not_ready', 409);
      if (!tenantAppUrl(input.url) || !validLicenseKey(input.licenseKey)) throw apiError('invalid_domain_or_license');
      await provision({...record, url: input.url, licenseKey: input.licenseKey, ...(input.domainVerificationToken === undefined ? {} : {domainVerificationToken: input.domainVerificationToken})});
      return upgrade({id: record.id, fingerprint: record.fingerprint, image: record.image});
    }
    if (url.pathname === '/control/reload') return reloadTenant(input);
    if (url.pathname === '/control/resources') return setCpuLimit(input);
    return provision(input);
  });
  jobs.set(input.id, job);
  try {
    const result = await job;
    security.audit('control_completed', {id: input.id, operation, status: result?.status});
    if (!res.headersSent) reply(res, 200, result);
  } catch (error) { security.audit('control_failed', {id: input.id, operation}); throw error; }
  finally { pendingControls--; if (jobs.get(input.id) === job) jobs.delete(input.id); }
}
async function target(req) {
  if (!equal(req.headers['x-spartan-origin'], cfg.ORIGIN_SECRET) || typeof req.headers['x-spartan-client-ip'] !== 'string' || !isIP(req.headers['x-spartan-client-ip'])) return null;
  const match = req.url.match(/^\/tenant\/(t-[a-f0-9]{24})(\/.*)$/);
  if (!match || sensitivePath(match[2])) return null;
  const record = await load(match[1]);
  if (!record || record.status !== 'ready') return null;
  const host = req.headers['x-spartan-host'];
  if (host !== `${record.id}.${cfg.BASE_DOMAIN}` && (req.headers['x-spartan-custom-domain'] !== '1' || typeof host !== 'string' || host.length > 200 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))) return null;
  const activeUrl = tenantAppUrl(record.containerUrl || record.url);
  if (!activeUrl) return null;
  const canonical = new URL(activeUrl);
  if (host !== canonical.hostname) {
    const query = match[2].indexOf('?');
    canonical.pathname = query === -1 ? match[2] : match[2].slice(0, query);
    canonical.search = query === -1 ? '' : match[2].slice(query);
    return {redirect: canonical.toString()};
  }
  if (localTenant(cfg, record)) return {url: new URL(`http://127.0.0.1:${record.port}${match[2]}`), record, local: true};
  if (req.headers['x-spartan-hop']) return null;
  const origin = record.primary === 'us' ? cfg.US_ORIGIN : cfg.DE_ORIGIN;
  return {url: new URL(`${origin}${req.url}`), record, local: false};
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__cloud_node_health' && req.method === 'GET') {
      if (!equal(req.headers['x-spartan-origin'], cfg.ORIGIN_SECRET)) return reply(res, 401, {error: 'unauthorized'});
      const databaseReady = !centralDatabase(cfg) || await mysql.ready();
      return reply(res, databaseReady ? 200 : 503, {status: databaseReady ? 'ready' : 'degraded', region: cfg.NODE_REGION, updateSafety: 1, pendingControls, maintenance: maintenance(), ...(centralDatabase(cfg) ? {databaseMode: 'us-central', databaseRegion: 'us', databaseReady} : {})});
    }
    if (url.pathname.startsWith('/control/')) return await control(req, res, url);
    if (url.pathname.startsWith('/admin/')) return await adminRoute(req, res, url);
    if (dashboardPort && (url.pathname === DASHBOARD_PATH || url.pathname.startsWith(`${DASHBOARD_PATH}/`))) return proxyDashboard(req, res, url);
    if (dashboardPort && url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(302, {location: `${DASHBOARD_PATH}/`, 'cache-control': 'no-store'}); return res.end(); }
    const info = await target(req);
    if (!info) return reply(res, 404, {error: 'not_found'});
    if (info.redirect) {
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 421, {error: 'canonical_domain_required'});
      res.writeHead(308, {location: info.redirect, 'cache-control': 'private, no-store'});
      return res.end();
    }
    const transport = info.url.protocol === 'https:' ? https : http;
    const upstream = transport.request(info.url, {method: req.method, headers: proxyHeaders(req, info)}, response => {
      const headers = {...response.headers, 'cache-control': proxyCacheControl(req.method, response.headers)};
      delete headers['x-powered-by'];
      res.writeHead(response.statusCode, headers);
      response.pipe(res);
    });
    upstream.setTimeout(60000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', error => {
      if (res.headersSent) return res.destroy();
      if (info.local && ['ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) refreshPort(info.record.id).catch(() => {});
      reply(res, 503, {error: 'origin_unavailable'});
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  } catch (error) {
    // execFile puts the whole command line in error.message, which for mysql includes
    // IDENTIFIED BY '<password>'. Prefer stderr, redact either, and never log the command.
    const safe = text => String(text || '').replace(/IDENTIFIED BY '[^']*'/g, "IDENTIFIED BY '<redacted>'").trim().replace(/\s+/g, ' ').slice(0, 300);
    const detail = error.stderr ? safe(error.stderr) : safe(String(error.message || '').replace(/^Command failed:[\s\S]*$/, 'command failed'));
    console.error(JSON.stringify({event: 'request_failed', code: String(error.code ?? error.message ?? '').slice(0, 60), detail}));
    if (!res.headersSent) reply(res, error.apiStatus || (error instanceof SyntaxError ? 400 : error.message === 'too_large' ? 413 : 503), {error: error.apiStatus ? error.message : error instanceof SyntaxError ? 'invalid_json' : error.message === 'too_large' ? 'body_too_large' : 'operation_failed'});
  }
});
server.on('upgrade', async (req, socket, head) => {
  try {
    const info = await target(req);
    if (!info) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    if (info.redirect) { socket.end('HTTP/1.1 421 Misdirected Request\r\n\r\n'); return; }
    const transport = info.url.protocol === 'https:' ? https : http;
    const upstream = transport.request(info.url, {headers: proxyHeaders(req, info)});
    upstream.on('upgrade', (res, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      socket.on('error', () => peer.destroy());
      peer.on('error', () => socket.destroy());
      socket.on('close', () => peer.destroy());
    });
    upstream.on('response', res => { res.resume(); socket.end(`HTTP/1.1 ${res.statusCode} Rejected\r\n\r\n`); });
    upstream.on('error', error => {
      if (info.local && ['ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) refreshPort(info.record.id).catch(() => {});
      socket.destroy();
    });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.end();
  } catch { socket.destroy(); }
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
const connections = new Set();
server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
process.once('SIGTERM', async () => {
  shuttingDown = true;
  await Promise.allSettled([...jobs.values()]);
  const deadline = setTimeout(() => { for (const socket of connections) socket.destroy(); process.exit(0); }, 15000);
  deadline.unref();
  server.close(() => { clearTimeout(deadline); process.exit(0); });
});
server.listen(port, '127.0.0.1');
(async () => {
  try { for (const id of (await readdir(root)).filter(validId)) await refreshPort(id).catch(() => {}); }
  catch { console.error(JSON.stringify({event: 'port_reconcile_failed'})); }
})();
