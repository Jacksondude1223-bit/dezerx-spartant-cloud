import {store, view, ApiError} from './store.mjs';
import {clients, REGIONS} from './nodes.mjs';
import {session, login, jsonBody, cookie} from './auth.mjs';
import {equal, seal} from './crypto.mjs';
import {createInstance, instanceAction, queueLifecycle} from './instances.mjs';
import {runJobs} from './jobs.mjs';
export const SECURITY = {'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()'};
export function response(value, status = 200, headers = {}) {return Response.json(value, {status, headers: {...SECURITY, 'cache-control': 'no-store', ...headers}});}
async function locked(db, id, action) {
  const key = 'tenant:' + id, token = await db.lock(key);
  if (!token) throw new ApiError(409, 'instance_busy');
  try {return await action();} finally {await db.unlock(key, token);}
}
async function presented(items, db) {
  const jobs = items.some(x => x.status === 'queued') ? await db.all("SELECT id FROM dashboard_jobs WHERE status IN ('queued', 'running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at") : [];
  return items.map(item => {
    const result = view(item);
    if (result.queue) result.queue = {...result.queue, position: Math.max(1, jobs.findIndex(x => x.id === item.jobId) + 1), length: Math.max(1, jobs.length)};
    return result;
  });
}
export function createWorker(fetchImpl = fetch) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        if (url.protocol !== 'https:') throw new ApiError(400, 'https_required');
        if (!url.pathname.startsWith('/api/')) {
          if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'method_not_allowed');
          if (url.pathname.startsWith('/vendor/') && !await session(request, env, store(env))) throw new ApiError(401, 'not_signed_in');
          const asset = await env.ASSETS.fetch(request);
          const headers = new Headers(asset.headers);
          for (const [key, value] of Object.entries(SECURITY)) headers.set(key, value);
          if (['/', '/index.html', '/app.js', '/styles.css'].includes(url.pathname)) headers.set('cache-control', 'no-store');
          return new Response(asset.body, {status: asset.status, headers});
        }
        const db = store(env), client = clients(env, fetchImpl), config = client.config;
        const application = await db.query("SELECT value FROM dashboard_metadata WHERE name = 'application'").first();
        if (application?.value !== 'spartan-dashboard') throw new ApiError(503, 'wrong_dashboard_database');
        const userSession = await session(request, env, db);
        const label = env.DASHBOARD_LABEL || 'Spartan Cloud';
        if (url.pathname === '/api/session' && request.method === 'GET') return response(userSession ? {authenticated: true, user: userSession.username, csrf: userSession.csrf, label, nodes: Object.keys(REGIONS).map(region => ({region, label: REGIONS[region], host: new URL(config.origins[region]).host})), provisioning: {baseDomain: config.baseDomain, instanceDomain: config.instanceDomain, databaseMode: env.DATABASE_MODE || 'local'}} : {authenticated: false, label, twoFactor: Boolean(env.DASHBOARD_TOTP_SECRET)});
        if (url.pathname === '/api/login' && request.method === 'POST') {
          if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) throw new ApiError(403, 'csrf_failed');
          const result = await login(request, await jsonBody(request, 4096), env, db, config);
          return response({authenticated: true, user: env.DASHBOARD_USER, csrf: result.csrf}, 200, {'set-cookie': cookie(result.token, Math.floor(config.hours * 3600))});
        }
        if (!userSession) throw new ApiError(401, 'not_signed_in');
        if (request.method !== 'GET' && (!equal(request.headers.get('x-csrf-token'), userSession.csrf) || (request.headers.get('origin') && request.headers.get('origin') !== url.origin))) throw new ApiError(403, 'csrf_failed');
        if (url.pathname === '/api/logout' && request.method === 'POST') {await db.query('DELETE FROM dashboard_sessions WHERE token_hash = ?', userSession.token_hash).run(); return response({authenticated: false}, 200, {'set-cookie': cookie('', 0)});}
        if (url.pathname === '/api/overview' && request.method === 'GET') return response(await client.overview());
        if (url.pathname === '/api/activity' && request.method === 'GET') return response({events: (await db.all('SELECT time, event, details FROM dashboard_activity ORDER BY id DESC LIMIT 300')).map(x => ({time: x.time, event: x.event, ...JSON.parse(x.details)}))});
        if (url.pathname === '/api/instances') {
          if (request.method === 'GET') return response({instances: await presented((await db.list()).filter(x => !x.external), db)});
          if (request.method === 'POST') return response(await createInstance(await jsonBody(request, 8192), userSession.username, env, client, db), 201);
          throw new ApiError(405, 'method_not_allowed');
        }
        const instance = url.pathname.match(/^\/api\/instances\/(t-[a-f0-9]{24})(?:\/(verify|deploy|cancel|discard))?$/);
        if (instance) {
          if (!instance[2] && request.method === 'GET') return response((await presented([await db.find(instance[1])], db))[0]);
          if (request.method !== 'POST' || !instance[2]) throw new ApiError(405, 'method_not_allowed');
          const input = await jsonBody(request, 8192);
          return response(await locked(db, instance[1], async () => instanceAction(await db.find(instance[1]), instance[2], input, userSession.username, env, client, db)), instance[2] === 'deploy' ? 202 : 200);
        }
        const lifecycle = url.pathname.match(/^\/api\/tenants\/(t-[a-f0-9]{24})\/lifecycle$/);
        if (lifecycle) {
          if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
          const input = await jsonBody(request, 1024);
          return response(await locked(db, lifecycle[1], () => queueLifecycle(lifecycle[1], input.action, userSession.username, client, db)), 202);
        }
        const match = url.pathname.match(/^\/api\/nodes\/(us|de)\/tenants\/(t-[a-f0-9]{24})\/(detail|logs|exec|fs|fs\/download|container|reload|upgrade|database|resources)$/);
        if (!match) throw new ApiError(404, 'not_found');
        const [, region, id, operation] = match;
        if (operation === 'detail' && request.method === 'GET') return response(await client.node(region, 'tenant', {id}));
        if (['fs/download', 'database'].includes(operation) && request.method === 'GET') {
          await db.audit('action', {user: userSession.username, region, id, action: operation});
          const upstream = await client.node(region, operation === 'database' ? 'database/download' : operation, {id, ...(operation === 'fs/download' ? {path: url.searchParams.get('path') || '', user: url.searchParams.get('user') || 'www-data'} : {})}, {raw: true, timeout: 90000});
          const headers = new Headers({...SECURITY, 'cache-control': 'private, no-store', 'content-type': upstream.headers.get('content-type') || 'application/octet-stream', 'content-disposition': upstream.headers.get('content-disposition') || `attachment; filename="${id}.sql"`});
          return new Response(upstream.body, {headers});
        }
        if (request.method !== 'POST' || operation === 'detail') throw new ApiError(405, 'method_not_allowed');
        const input = await jsonBody(request, operation === 'fs' ? 9 * 1024 * 1024 : 65536);
        await db.audit('action', {user: userSession.username, region, id, action: operation, runAs: input.user || 'www-data'});
        const payload = {...input, id};
        return response(await client.node(region, operation, payload, {timeout: ['upgrade', 'fs', 'reload', 'container', 'exec'].includes(operation) ? 90000 : 25000}));
      } catch (error) {return response({error: error instanceof ApiError ? error.message : 'dashboard_operation_failed'}, error instanceof ApiError ? error.status : 503);}
    },
    async scheduled(controller, env, ctx) {
      ctx.waitUntil((async () => {
        await runJobs(env, fetchImpl);
        const db = store(env), now = Date.now();
        await db.db.batch([
          db.query('DELETE FROM dashboard_sessions WHERE expires < ?', now),
          db.query('DELETE FROM dashboard_rate_limits WHERE expires < ?', now),
          db.query("DELETE FROM dashboard_jobs WHERE status IN ('done', 'failed') AND created_at < ?", now - 30 * 86400000),
          db.query('DELETE FROM dashboard_activity WHERE id < (SELECT COALESCE(MAX(id), 0) - 5000 FROM dashboard_activity)')
        ]);
      })());
    }
  };
}
export default createWorker();
