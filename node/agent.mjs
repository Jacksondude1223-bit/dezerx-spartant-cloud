import http from 'node:http';
import {isIP} from 'node:net';
import {applyLifecycle} from './service-lifecycle.mjs';
import {proxyHeaders} from './client-ip.mjs';
import https from 'node:https';
import {createHmac, timingSafeEqual, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, rename, chmod, readdir, unlink} from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {createInitialAdmin, validInitialAdmin} from './initial-admin.mjs';
import {createRecovery} from './recovery.mjs';

const run = promisify(execFile);
const cfg = process.env;
for (const key of ['NODE_REGION', 'NODE_CONTROL_SECRET', 'ORIGIN_SECRET', 'BASE_DOMAIN', 'SPARTAN_IMAGE', 'US_ORIGIN', 'DE_ORIGIN']) {
  if (!cfg[key] || cfg[key].includes('CHANGE_ME')) throw new Error(`missing_${key}`);
}
if (!['us', 'de'].includes(cfg.NODE_REGION)) throw new Error('invalid_region');
if (!/^\S+@sha256:[a-f0-9]{64}$/.test(cfg.SPARTAN_IMAGE)) throw new Error('image_digest_required');
if (cfg.NODE_CONTROL_SECRET.length < 32 || cfg.ORIGIN_SECRET.length < 32) throw new Error('weak_secret');
for (const key of ['US_ORIGIN', 'DE_ORIGIN']) if (new URL(cfg[key]).protocol !== 'https:') throw new Error('https_required');
const root = cfg.DATA_ROOT || '/srv/spartan-cloud';
const port = Number(cfg.AGENT_PORT || 8788);
const jobs = new Map();
const syncJobs = new Map();
const validId = id => /^t-[a-f0-9]{24}$/.test(id || '');
const container = id => `spartan-${id}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const reply = (res, status, payload) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(payload)); };
const docker = async args => (await run('docker', args, {timeout: 120000, maxBuffer: 1024 * 1024})).stdout.trim();
const recovery = createRecovery({config: cfg, root, docker: async args => {
  const result = await run('docker', args, {timeout: 20000, maxBuffer: 1024 * 1024});
  return args[0] === 'logs' ? `${result.stdout}\n${result.stderr}` : result.stdout.trim();
}, run});
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
async function provisionOnce(input, progress) {
  progress.stage = 'prepare';
  const {id, primary, appKey, url, fingerprint} = input;
  if (!validId(id) || !['us', 'de'].includes(primary) || !/^base64:[A-Za-z0-9+/]{43}=$/.test(appKey || '') || url !== `https://${id}.${cfg.BASE_DOMAIN}` || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new Error('invalid_input');
  if (input.initialAdmin !== undefined && !validInitialAdmin(input.initialAdmin)) throw new Error('invalid_initial_admin');
  const {initialAdmin, ...persistedInput} = input;
  const existing = await load(id);
  persistedInput.adminInitialized = existing?.adminInitialized === true || existing?.status === 'ready';
  const version = input.lifecycleVersion || 0;
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('invalid_input');
  if (existing?.status === 'terminated') throw new Error('service_terminated');
  if (version < (existing?.lifecycleVersion || 0) || existing?.status === 'suspended' && version <= (existing.lifecycleVersion || 0)) throw new Error('stale_operation');
  if (existing && (existing.fingerprint !== fingerprint || existing.appKey && existing.appKey !== appKey || existing.primary && existing.primary !== primary)) throw new Error('tenant_conflict');
  const directory = path.join(root, id);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const role = primary === cfg.NODE_REGION ? 'primary' : 'secondary';
  for (const name of ['database', 'storage']) {
    const dir = path.join(directory, name);
    await mkdir(dir, {recursive: true, mode: 0o700});
    await run('chown', ['-R', '33:33', dir]);
  }
  const env = {APP_NAME: 'Spartan', APP_ENV: 'production', APP_DEBUG: 'false', APP_KEY: appKey, APP_URL: url, ASSET_URL: url, LOG_CHANNEL: 'stderr', DB_CONNECTION: 'sqlite', DB_DATABASE: '/var/www/html/database/persistent/database.sqlite', DB_FOREIGN_KEYS: 'true', SESSION_DRIVER: 'file', SESSION_SECURE_COOKIE: 'true', SESSION_SAME_SITE: 'lax', CACHE_STORE: 'file', CACHE_DRIVER: 'file', QUEUE_CONNECTION: 'database', CLOUD_ROLE: role, TENANT_ID: id};
  const additional = cfg.LARAVEL_ENV_FILE ? JSON.parse(await readFile(cfg.LARAVEL_ENV_FILE, 'utf8')) : {};
  for (const [key, value] of Object.entries(additional)) {
    if (key in env || !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('invalid_laravel_env');
    env[key] = value;
  }
  const envFile = path.join(directory, 'app.env');
  await writeFile(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
  await chmod(envFile, 0o600);
  await save({...persistedInput, role, status: 'provisioning'});
  let inspect;
  try { inspect = JSON.parse(await docker(['inspect', container(id)]))[0]; }
  catch { inspect = null; }
  if (!inspect) {
    const count = (await readdir(root)).filter(validId).length;
    if (count > Number(cfg.MAX_TENANTS || 100)) throw new Error('node_capacity');
    progress.stage = 'pull';
    await docker(['pull', cfg.SPARTAN_IMAGE]);
    progress.stage = 'launch';
    await docker(['run', '-d', '--name', container(id), '--label', 'spartan.managed=true', '--label', `spartan.tenant=${id}`, '--label', `spartan.role=${role}`, '--label', `spartan.fingerprint=${fingerprint}`, '--restart', 'unless-stopped', '--cpus', cfg.TENANT_CPUS || '1', '--memory', cfg.TENANT_MEMORY || '512m', '--memory-swap', cfg.TENANT_MEMORY || '512m', '--pids-limit', '256', '--security-opt', 'no-new-privileges:true', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--env-file', envFile, '-p', '127.0.0.1::8080', '--mount', `type=bind,src=${directory}/database,dst=/var/www/html/database/persistent`, '--mount', `type=bind,src=${directory}/storage,dst=/var/www/html/storage`, cfg.SPARTAN_IMAGE]);
  } else {
    if (inspect.Config.Labels?.['spartan.fingerprint'] !== fingerprint) throw new Error('container_conflict');
    if (existing?.status === 'suspended') await docker(['update', '--restart=unless-stopped', container(id)]);
    if (!inspect.State.Running) { progress.stage = 'start'; await docker(['start', container(id)]); }
  }
  inspect = JSON.parse(await docker(['inspect', container(id)]))[0];
  const assignedPort = Number(inspect.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort);
  if (!assignedPort) throw new Error('missing_port');
  await save({...persistedInput, role, port: assignedPort, status: 'provisioning'});
  progress.stage = 'health';
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const health = await fetch(`http://127.0.0.1:${assignedPort}/__cloud_health`, {signal: AbortSignal.timeout(2000)});
      if (health.ok) {
        if (role === 'primary' && initialAdmin && !persistedInput.adminInitialized) {
          progress.stage = 'initial_admin';
          await createInitialAdmin(id, initialAdmin);
          persistedInput.adminInitialized = true;
        }
        await save({...persistedInput, role, port: assignedPort, status: 'ready'});
        await recovery.success(id).catch(() => {});
        progress.stage = 'replica';
        if (role === 'secondary') await synchronize(id);
        return {id, status: 'ready', role};
      }
    } catch (error) { if (progress.stage === 'initial_admin') throw error; }
    await sleep(1000);
  }
  return {id, status: 'provisioning', role};
}
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
      if (['invalid_input', 'tenant_conflict', 'container_conflict', 'node_capacity', 'invalid_laravel_env', 'invalid_initial_admin', 'initial_admin_failed', 'stale_operation', 'service_terminated'].includes(error.message)) throw error;
      if (!mayRecover || attempt === 2 || !await recovery.recover(input.id, progress.stage, error).catch(() => false)) throw error;
    }
  }
  throw new Error('recovery_exhausted');
}
async function synchronize(id) {
  if (syncJobs.has(id)) return syncJobs.get(id);
  const job = (async () => {
    const record = await load(id);
    if (!record || record.role !== 'secondary' || record.status !== 'ready') return;
    const origin = record.primary === 'us' ? cfg.US_ORIGIN : cfg.DE_ORIGIN;
    const snapshot = path.join(root, id, 'database', `snapshot-${randomUUID()}.sqlite`);
    try {
      const response = await fetch(`${origin}/replica/${id}`, {headers: {'x-spartan-origin': cfg.ORIGIN_SECRET}, signal: AbortSignal.timeout(120000), redirect: 'error'});
      if (!response.ok || !response.body) throw new Error('snapshot_unavailable');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(snapshot, {mode: 0o600}));
      const check = await run('sqlite3', [snapshot, 'PRAGMA integrity_check;'], {timeout: 30000});
      if (check.stdout.trim() !== 'ok') throw new Error('snapshot_corrupt');
      await run('chown', ['33:33', snapshot]);
      await rename(snapshot, path.join(root, id, 'database', 'database.sqlite'));
      await writeFile(path.join(root, id, 'replica.json'), JSON.stringify({syncedAt: new Date().toISOString(), primary: record.primary}), {mode: 0o600});
    } finally { await unlink(snapshot).catch(() => {}); }
  })().finally(() => syncJobs.delete(id));
  syncJobs.set(id, job);
  return job;
}
async function snapshot(req, res, id) {
  if (req.method !== 'GET' || !equal(req.headers['x-spartan-origin'], cfg.ORIGIN_SECRET) || !validId(id)) return reply(res, 404, {error: 'not_found'});
  const record = await load(id);
  if (!record || record.role !== 'primary' || record.status !== 'ready') return reply(res, 404, {error: 'not_found'});
  const filename = `snapshot-${randomUUID()}.sqlite`;
  const inside = `/var/www/html/database/persistent/${filename}`;
  const outside = path.join(root, id, filename);
  try {
    await docker(['exec', container(id), 'sqlite3', '/var/www/html/database/persistent/database.sqlite', '.timeout 10000', `.backup '${inside}'`]);
    await docker(['cp', `${container(id)}:${inside}`, outside]);
    await chmod(outside, 0o600);
    await docker(['exec', container(id), 'rm', '-f', inside]);
    res.writeHead(200, {'content-type': 'application/octet-stream', 'cache-control': 'no-store'});
    await pipeline(createReadStream(outside), res);
  } finally {
    await unlink(outside).catch(() => {});
    await docker(['exec', container(id), 'rm', '-f', inside]).catch(() => {});
  }
}
async function body(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function control(req, res, url) {
  const payload = await body(req);
  const timestamp = req.headers['x-spartan-timestamp'];
  const expected = createHmac('sha256', cfg.NODE_CONTROL_SECRET).update(`${timestamp}\n${req.method}\n${url.pathname}\n${payload}`).digest('hex');
  if (req.method !== 'POST' || !/^\d+$/.test(timestamp || '') || Math.abs(Date.now() - Number(timestamp)) > 300000 || !equal(expected, req.headers['x-spartan-signature'])) return reply(res, 401, {error: 'unauthorized'});
  if (!['/control/provision', '/control/lifecycle'].includes(url.pathname)) return reply(res, 404, {error: 'not_found'});
  const input = JSON.parse(payload);
  if (!validId(input.id)) return reply(res, 400, {error: 'invalid_id'});
  const previous = jobs.get(input.id) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => url.pathname === '/control/lifecycle' ? applyLifecycle(input, {root, load, save, docker}) : provision(input));
  jobs.set(input.id, job);
  try { const result = await job; reply(res, 200, result); }
  finally { if (jobs.get(input.id) === job) jobs.delete(input.id); }
}
async function target(req) {
  if (!equal(req.headers['x-spartan-origin'], cfg.ORIGIN_SECRET) || typeof req.headers['x-spartan-client-ip'] !== 'string' || !isIP(req.headers['x-spartan-client-ip'])) return null;
  const match = req.url.match(/^\/tenant\/(t-[a-f0-9]{24})(\/.*)$/);
  if (!match) return null;
  const record = await load(match[1]);
  if (!record || record.status !== 'ready') return null;
  const host = req.headers['x-spartan-host'];
  if (host !== `${record.id}.${cfg.BASE_DOMAIN}` && (req.headers['x-spartan-custom-domain'] !== '1' || typeof host !== 'string' || host.length > 200 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))) return null;
  if (record.role === 'primary') return {url: new URL(`http://127.0.0.1:${record.port}${match[2]}`), record, local: true};
  if (req.headers['x-spartan-hop']) return null;
  const origin = record.primary === 'us' ? cfg.US_ORIGIN : cfg.DE_ORIGIN;
  return {url: new URL(`${origin}${req.url}`), record, local: false};
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/control/')) return await control(req, res, url);
    if (url.pathname.startsWith('/replica/')) return await snapshot(req, res, url.pathname.slice('/replica/'.length));
    const info = await target(req);
    if (!info) return reply(res, 404, {error: 'not_found'});
    const transport = info.url.protocol === 'https:' ? https : http;
    const upstream = transport.request(info.url, {method: req.method, headers: proxyHeaders(req, info)}, response => {
      const headers = {...response.headers, 'cache-control': 'private, no-store'};
      delete headers['x-powered-by'];
      res.writeHead(response.statusCode, headers);
      response.pipe(res);
    });
    upstream.setTimeout(60000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => { if (!res.headersSent) reply(res, 503, {error: 'origin_unavailable'}); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  } catch (error) {
    console.error(JSON.stringify({event: 'request_failed', code: String(error.code || error.message).slice(0, 100)}));
    if (!res.headersSent) reply(res, error instanceof SyntaxError ? 400 : 503, {error: error instanceof SyntaxError ? 'invalid_json' : 'operation_failed'});
  }
});
server.on('upgrade', async (req, socket, head) => {
  try {
    const info = await target(req);
    if (!info) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
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
    upstream.on('error', () => socket.destroy());
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.end();
  } catch { socket.destroy(); }
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.listen(port, '127.0.0.1');
let syncing = false;
setInterval(async () => {
  if (syncing) return;
  syncing = true;
  try {
    for (const id of (await readdir(root)).filter(validId)) {
      try { await synchronize(id); }
      catch { console.error(JSON.stringify({event: 'replica_sync_failed', id})); }
    }
  } catch { console.error(JSON.stringify({event: 'replica_scan_failed'})); }
  finally { syncing = false; }
}, Math.max(60000, Number(cfg.REPLICA_INTERVAL_MS || 300000))).unref();
