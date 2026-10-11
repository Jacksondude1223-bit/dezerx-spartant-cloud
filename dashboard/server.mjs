import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {createProvisioner, loadProvisioningConfig, ProvisionError} from './provisioning.mjs';

// Operator dashboard for Spartan Cloud nodes. The browser never sees ADMIN_API_SECRET:
// it talks to this server with a session cookie, and this server signs each call to
// the node agents' /admin/* routes. Listen on loopback and reach it through an SSH
// tunnel or a Cloudflare Tunnel route protected by Cloudflare Access.

const scrypt = promisify(scryptCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const REGIONS = {us: 'United States', de: 'Germany'};
const STATIC = {'/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.png': ['favicon.png', 'image/png'], '/logo.png': ['logo.png', 'image/png']};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

export async function hashPassword(password, {salt = randomBytes(16), N = 16384, r = 8, p = 1} = {}) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Password must be 12 to 1024 characters');
  const key = await scrypt(password, salt, 32, {N, r, p, maxmem: 64 * 1024 * 1024});
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string' || password.length > 1024) return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const expected = Buffer.from(parts[5], 'base64');
  if (![N, r, p].every(Number.isSafeInteger) || N > 1048576 || expected.length !== 32) return false;
  const key = await scrypt(password, Buffer.from(parts[4], 'base64'), 32, {N, r, p, maxmem: 256 * 1024 * 1024});
  return timingSafeEqual(key, expected);
}

// RFC 6238 time-based one-time codes (SHA-1, 6 digits, 30 s), as used by authenticator apps.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const char of String(text).toUpperCase().replace(/[\s=]/g, '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid_base32');
    value = ((value << 5) | index) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpCode(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
// Accepts the previous, current and next 30-second step, and never the same step twice.
export function checkTotp(secret, code, time = Date.now(), lastCounter = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(time / 30000);
  for (const counter of [step - 1, step, step + 1]) {
    if (counter > lastCounter && timingSafeEqual(Buffer.from(totpCode(secret, counter)), Buffer.from(code))) return counter;
  }
  return null;
}

const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
export function loadConfig(env = process.env) {
  const secret = env.ADMIN_API_SECRET || '';
  if (secret.length < 32 || /[\x00-\x20\x7f]/.test(secret)) throw new Error('ADMIN_API_SECRET must be at least 32 characters (the same value as on the nodes)');
  if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(env.DASHBOARD_USER || '')) throw new Error('DASHBOARD_USER is required (letters, digits, _ . @ -)');
  if (!String(env.DASHBOARD_PASSWORD_HASH || '').startsWith('scrypt$')) throw new Error('DASHBOARD_PASSWORD_HASH is required; create it with: node dashboard/server.mjs hash-password');
  const nodes = {};
  for (const region of Object.keys(REGIONS)) {
    const value = env[`${region.toUpperCase()}_ORIGIN`];
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw new Error(`${region.toUpperCase()}_ORIGIN must use https (http is allowed only for 127.0.0.1)`);
    nodes[region] = url.origin;
  }
  if (!Object.keys(nodes).length) throw new Error('Set US_ORIGIN and/or DE_ORIGIN');
  const basePath = env.DASHBOARD_BASE_PATH || '';
  if (basePath && !/^\/[a-z0-9-]{1,32}$/.test(basePath)) throw new Error('DASHBOARD_BASE_PATH must look like /panel');
  const totpSecret = env.DASHBOARD_TOTP_SECRET || '';
  if (totpSecret && (!/^[A-Z2-7]{16,128}$/.test(totpSecret) || base32Decode(totpSecret).length < 10)) throw new Error('DASHBOARD_TOTP_SECRET must be a base32 secret of at least 16 characters');
  // Optional: with ORIGIN_SECRET and BASE_DOMAIN the dashboard can also create instances.
  const provisioning = loadProvisioningConfig(env, secret);
  return {secret, nodes, provisioning, user: env.DASHBOARD_USER, passwordHash: env.DASHBOARD_PASSWORD_HASH, host: env.DASHBOARD_HOST || '127.0.0.1', port: Number(env.DASHBOARD_PORT || 8790), secureCookie: env.DASHBOARD_SECURE_COOKIE !== 'false', sessionHours: Number(env.DASHBOARD_SESSION_HOURS || 12), publicLabel: env.DASHBOARD_LABEL || 'Spartan Cloud', basePath, totpSecret};
}

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; } }

export function createDashboard(config, {now = Date.now, log = value => console.log(JSON.stringify(value)), fetchImpl = fetch} = {}) {
  const sessions = new Map();
  const attempts = new Map();
  const activity = [];
  let globalAttempts = {count: 0, reset: now() + 60000};
  const record = (event, fields) => {
    const entry = {time: new Date(now()).toISOString(), event, ...fields};
    activity.push(entry);
    if (activity.length > 300) activity.shift();
    log({source: 'spartan-dashboard', ...entry});
  };

  const provisioner = config.provisioning ? createProvisioner(config, {nodes: config.nodes, now, fetchImpl, record: (action, fields) => record('action', {action, ...fields})}) : null;

  const clientIp = req => {
    const remote = req.socket.remoteAddress || '';
    const forwarded = req.headers['cf-connecting-ip'];
    // Only cloudflared (or an SSH tunnel) reaches a loopback listener, so its header is trustworthy here.
    return /^(127\.|::1$|::ffff:127\.)/.test(remote) && typeof forwarded === 'string' && forwarded.length < 64 ? forwarded : remote;
  };
  const cookieOf = req => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === 'spartan_admin') return value.join('=');
    }
    return null;
  };
  const sessionOf = req => {
    const token = cookieOf(req);
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expires < now()) { sessions.delete(token); return null; }
    return {token, ...session};
  };
  // Scoped to the dashboard path, so the cookie is never sent to the node's /control or /tenant routes.
  const cookie = (token, maxAge) => `spartan_admin=${token}; Path=${config.basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? '; Secure' : ''}`;
  let lastTotpCounter = -1;

  const send = (res, status, payload, headers = {}) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, {...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers});
    res.end(JSON.stringify(payload));
  };
  async function readJson(req, limit) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'json_required');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'body_too_large');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new HttpError(400, 'invalid_json'); }
  }

  function limitLogin(ip) {
    const time = now();
    if (globalAttempts.reset < time) globalAttempts = {count: 0, reset: time + 60000};
    const entry = attempts.get(ip) && attempts.get(ip).reset > time ? attempts.get(ip) : {count: 0, reset: time + 15 * 60000};
    entry.count++;
    attempts.set(ip, entry);
    if (attempts.size > 10000) attempts.clear();
    return ++globalAttempts.count <= 60 && entry.count <= 10;
  }

  async function node(region, operation, payload = {}, {timeout = 30000, raw = false} = {}) {
    const origin = config.nodes[region];
    if (!origin) throw new HttpError(404, 'unknown_node');
    const pathname = `/admin/${operation}`;
    const body = JSON.stringify(payload);
    const timestamp = String(now());
    const sig = createHmac('sha256', config.secret).update(`${timestamp}\nPOST\n${pathname}\n${body}`).digest('hex');
    let response;
    try {
      response = await fetchImpl(origin + pathname, {method: 'POST', headers: {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': sig, 'user-agent': 'spartan-dashboard'}, body, redirect: 'manual', signal: AbortSignal.timeout(timeout)});
    } catch (error) {
      throw new HttpError(error?.name === 'TimeoutError' ? 504 : 502, error?.name === 'TimeoutError' ? 'node_timeout' : 'node_unreachable');
    }
    if (raw && response.ok) return response;
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    // Cloudflare answers 524 when a node takes over 100 seconds; the node keeps working.
    if (response.status === 524) throw new HttpError(504, 'still_running_on_node');
    if (!data) throw new HttpError(502, response.status === 403 ? 'blocked_by_cloudflare' : 'invalid_node_response');
    if (!response.ok) throw new HttpError(response.status, String(data.error || 'node_error').slice(0, 80));
    return data;
  }
  async function stream(res, response, fallbackName) {
    const headers = {...SECURITY_HEADERS, 'cache-control': 'private, no-store', 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'content-disposition': response.headers.get('content-disposition') || `attachment; filename="${fallbackName}"`};
    const length = response.headers.get('content-length');
    if (length) headers['content-length'] = length;
    res.writeHead(200, headers);
    const source = Readable.fromWeb(response.body);
    res.once('close', () => source.destroy());
    await new Promise(resolve => { source.once('end', resolve); source.once('error', resolve); res.once('close', resolve); source.pipe(res); });
  }

  async function overview() {
    const regions = Object.keys(config.nodes);
    const results = await Promise.all(regions.map(async region => {
      const endpoint = new URL(config.nodes[region]).host;
      // Round trip of a no-op call. Agents older than /admin/ping answer 404 and show no latency.
      const ping = (async () => { const started = now(); try { await node(region, 'ping', {}, {timeout: 10000}); return now() - started; } catch { return null; } })();
      try {
        const [data, latencyMs] = await Promise.all([node(region, 'overview', {}, {timeout: 25000}), ping]);
        return {region, label: REGIONS[region], endpoint, ok: true, latencyMs, ...data, host: data.host || endpoint};
      }
      catch (error) { await ping; return {region, label: REGIONS[region], endpoint, host: endpoint, ok: false, error: error.message}; }
    }));
    return {nodes: results, sampledAt: new Date(now()).toISOString()};
  }

  const TENANT = /^\/api\/nodes\/(us|de)\/tenants\/(t-[a-f0-9]{24})\/(detail|logs|exec|fs|fs\/download|container|reload|upgrade|database)$/;
  async function api(req, res, url) {
    const ip = clientIp(req);
    if (url.pathname === '/api/session' && req.method === 'GET') {
      const session = sessionOf(req);
      return send(res, 200, session ? {authenticated: true, user: session.user, csrf: session.csrf, label: config.publicLabel, nodes: Object.keys(config.nodes).map(region => ({region, label: REGIONS[region], host: new URL(config.nodes[region]).host})), provisioning: provisioner ? {baseDomain: config.provisioning.baseDomain} : null} : {authenticated: false, label: config.publicLabel, twoFactor: Boolean(config.totpSecret)});
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!limitLogin(ip)) { record('login_rate_limited', {ip}); return send(res, 429, {error: 'too_many_attempts'}); }
      const input = await readJson(req, 4096);
      const userOk = typeof input.username === 'string' && input.username.length === config.user.length && timingSafeEqual(Buffer.from(input.username), Buffer.from(config.user));
      const passwordOk = await verifyPassword(String(input.password || ''), config.passwordHash);
      const counter = config.totpSecret ? checkTotp(config.totpSecret, input.code, now(), lastTotpCounter) : 0;
      if (!userOk || !passwordOk || counter === null) { record('login_failed', {ip}); return send(res, 401, {error: config.totpSecret ? 'invalid_credentials_or_code' : 'invalid_credentials'}); }
      if (config.totpSecret) lastTotpCounter = counter;
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(24).toString('base64url');
      if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
      sessions.set(token, {user: config.user, csrf, ip, expires: now() + config.sessionHours * 3600000});
      attempts.delete(ip);
      record('login', {user: config.user, ip});
      return send(res, 200, {authenticated: true, user: config.user, csrf}, {'set-cookie': cookie(token, Math.floor(config.sessionHours * 3600))});
    }
    const session = sessionOf(req);
    if (!session) return send(res, 401, {error: 'not_signed_in'});
    const mutating = req.method !== 'GET';
    if (mutating) {
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf.length !== session.csrf.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))) return send(res, 403, {error: 'csrf_failed'});
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(session.token);
      record('logout', {user: session.user, ip});
      return send(res, 200, {authenticated: false}, {'set-cookie': cookie('', 0)});
    }
    if (url.pathname === '/api/overview' && req.method === 'GET') return send(res, 200, await overview());
    if (url.pathname === '/api/activity' && req.method === 'GET') return send(res, 200, {events: [...activity].reverse()});
    if (url.pathname === '/api/instances' || url.pathname.startsWith('/api/instances/')) return instances(req, res, url, session, ip);
    const match = url.pathname.match(TENANT);
    if (!match) return send(res, 404, {error: 'not_found'});
    const [, region, id, operation] = match;
    const audit = (action, extra = {}) => record('action', {user: session.user, ip, region, id, action, ...extra});
    if (operation === 'detail' && req.method === 'GET') return send(res, 200, await node(region, 'tenant', {id}));
    if (operation === 'fs/download' && req.method === 'GET') {
      const target = url.searchParams.get('path') || '';
      const user = url.searchParams.get('user') || 'www-data';
      audit('download', {path: target.slice(0, 300), runAs: user});
      return stream(res, await node(region, 'fs/download', {id, path: target, user}, {timeout: 30 * 60000, raw: true}), 'download');
    }
    if (operation === 'database' && req.method === 'GET') {
      audit('database_download');
      return stream(res, await node(region, 'database/download', {id}, {timeout: 10 * 60000, raw: true}), `${id}.sql`);
    }
    if (req.method !== 'POST') return send(res, 405, {error: 'method_not_allowed'});
    const input = await readJson(req, operation === 'fs' ? 9 * 1024 * 1024 : 65536);
    if (operation === 'logs') return send(res, 200, await node(region, 'logs', {id, tail: input.tail}));
    if (operation === 'exec') {
      audit('exec', {runAs: input.user || 'www-data', command: String(input.command || '').slice(0, 200)});
      const seconds = Number.isInteger(input.timeoutSeconds) ? input.timeoutSeconds : 30;
      return send(res, 200, await node(region, 'exec', {id, command: input.command, cwd: input.cwd, user: input.user, timeoutSeconds: input.timeoutSeconds}, {timeout: (Math.min(seconds, 90) + 20) * 1000}));
    }
    if (operation === 'fs') {
      const {id: ignored, ...request} = input;
      if (!['list', 'stat', 'read'].includes(request.action) && !(request.action === 'upload' && request.offset > 0)) audit(`fs_${String(request.action).slice(0, 12)}`, {path: String(request.path || '').slice(0, 300), runAs: request.user || 'www-data'});
      return send(res, 200, await node(region, 'fs', {...request, id}, {timeout: request.action === 'extract' ? 300000 : 120000}));
    }
    if (operation === 'container') { audit(`container_${String(input.action).slice(0, 12)}`); return send(res, 200, await node(region, 'container', {id, action: input.action}, {timeout: 90000})); }
    if (operation === 'reload') { audit('reload'); return send(res, 200, await node(region, 'reload', {id}, {timeout: 90000})); }
    if (operation === 'upgrade') { audit('upgrade'); return send(res, 200, await node(region, 'upgrade', {id}, {timeout: 300000})); }
    return send(res, 404, {error: 'not_found'});
  }

  const INSTANCE = /^\/api\/instances\/(t-[a-f0-9]{24})(?:\/(verify|deploy|discard))?$/;
  async function instances(req, res, url, session, ip) {
    if (!provisioner) return send(res, 404, {error: 'provisioning_disabled'});
    try {
      if (url.pathname === '/api/instances') {
        if (req.method === 'GET') return send(res, 200, {instances: await provisioner.list()});
        if (req.method === 'POST') return send(res, 201, await provisioner.create(await readJson(req, 8192), session.user));
        return send(res, 405, {error: 'method_not_allowed'});
      }
      const match = url.pathname.match(INSTANCE);
      if (!match) return send(res, 404, {error: 'not_found'});
      const [, id, operation] = match;
      if (!operation && req.method === 'GET') return send(res, 200, await provisioner.get(id));
      if (req.method !== 'POST') return send(res, 405, {error: 'method_not_allowed'});
      const input = await readJson(req, 8192);
      if (operation === 'verify') return send(res, 200, await provisioner.verify(id));
      if (operation === 'deploy') return send(res, 202, await provisioner.deploy(id, input, session.user));
      if (operation === 'discard') return send(res, 200, await provisioner.discard(id, session.user));
      return send(res, 404, {error: 'not_found'});
    } catch (error) {
      if (error instanceof ProvisionError) return send(res, error.status, {error: error.message});
      throw error;
    }
  }

  const assets = new Map();
  async function asset(res, pathname) {
    const [file, type] = STATIC[pathname];
    if (!assets.has(file)) assets.set(file, await readFile(path.join(here, 'public', file)));
    res.writeHead(200, {...SECURITY_HEADERS, 'content-type': type, 'cache-control': pathname === '/' || pathname === '/index.html' ? 'no-store' : 'no-cache'});
    res.end(assets.get(file));
  }

  const server = http.createServer(async (req, res) => {
    try {
      let url = new URL(req.url, 'http://dashboard.local');
      // Behind the node agent the dashboard lives under a prefix such as /panel.
      if (config.basePath) {
        if (url.pathname === config.basePath) { res.writeHead(308, {...SECURITY_HEADERS, location: `${config.basePath}/${url.search}`}); return res.end(); }
        if (!url.pathname.startsWith(`${config.basePath}/`)) return send(res, 404, {error: 'not_found'});
        url = new URL(url.pathname.slice(config.basePath.length) + url.search, 'http://dashboard.local');
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) return await asset(res, url.pathname);
      return send(res, 404, {error: 'not_found'});
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, {error: error.message});
      console.error(JSON.stringify({source: 'spartan-dashboard', event: 'request_failed', detail: String(error?.message || error).slice(0, 200)}));
      return send(res, 500, {error: 'dashboard_error'});
    }
  });
  server.provisioner = provisioner;
  return server;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'hash-password') {
    // Reads the password from stdin so it never appears in the process list or shell history.
    readStdin().then(hashPassword).then(value => console.log(value)).catch(error => { console.error(error.message); process.exitCode = 1; });
  } else if (process.argv[2] === 'totp-secret') {
    console.log(base32Encode(randomBytes(20)));
  } else if (process.argv[2] === 'totp-check') {
    // stdin: "SECRET CODE"; exits 0 when the code is valid right now.
    readStdin().then(text => { const [secret, code] = text.trim().split(/\s+/); process.exitCode = checkTotp(secret, code) === null ? 1 : 0; }).catch(() => { process.exitCode = 1; });
  } else {
    const config = loadConfig();
    const server = createDashboard(config);
    server.headersTimeout = 15000;
    server.requestTimeout = 300000;
    server.listen(config.port, config.host, () => console.log(JSON.stringify({source: 'spartan-dashboard', event: 'listening', host: config.host, port: config.port, nodes: Object.keys(config.nodes)})));
    process.once('SIGTERM', () => server.close(() => process.exit(0)));
  }
}
