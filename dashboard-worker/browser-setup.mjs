import {equal, hashPassword, seal, open} from './crypto.mjs';
import {ApiError} from './store.mjs';
import {configuration, configurationIssues} from './nodes.mjs';
import {limitLogin, jsonBody} from './auth.mjs';
export async function credentials(env, db) {
  if (env.DASHBOARD_PASSWORD_HASH) return env;
  const row = await db.query("SELECT value FROM dashboard_metadata WHERE name = 'auth_account'").first();
  if (!row) return null;
  const account = await open(env.DASHBOARD_DATA_KEY, 'dashboard-auth', row.value);
  return {...env, DASHBOARD_USER: account.username, DASHBOARD_PASSWORD_HASH: account.passwordHash};
}
export async function browserSetup(request, env, db) {
  const identity = await db.query("SELECT value FROM dashboard_metadata WHERE name = 'application'").first();
  if (identity?.value !== 'spartan-dashboard') throw new ApiError(503, 'wrong_dashboard_database');
  const initialized = Boolean(await credentials(env, db));
  const missingSettings = ['ADMIN_API_SECRET', 'ORIGIN_SECRET', 'DASHBOARD_DATA_KEY', 'DASHBOARD_SETUP_TOKEN'].filter(key => !env[key]);
  if (request.method === 'GET') {
    const invalidSettings = configurationIssues(env).filter(issue => !missingSettings.includes(issue.name));
    if (env.DASHBOARD_SETUP_TOKEN && (typeof env.DASHBOARD_SETUP_TOKEN !== 'string' || env.DASHBOARD_SETUP_TOKEN.length < 32)) invalidSettings.push({name: 'DASHBOARD_SETUP_TOKEN', reason: 'Must be at least 32 characters. Use the generated setup token.'});
    return {initialized, missingSettings, invalidSettings};
  }
  if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  if (initialized) throw new ApiError(409, 'setup_already_completed');
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new ApiError(403, 'csrf_failed');
  if (typeof env.DASHBOARD_SETUP_TOKEN !== 'string' || env.DASHBOARD_SETUP_TOKEN.length < 32) throw new ApiError(503, 'setup_token_required');
  configuration(env);
  await limitLogin(request, db);
  const input = await jsonBody(request, 4096);
  if (!equal(input.setupToken, env.DASHBOARD_SETUP_TOKEN)) throw new ApiError(401, 'invalid_setup_token');
  if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(input.username || '')) throw new ApiError(400, 'invalid_username');
  if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 1024) throw new ApiError(400, 'invalid_password');
  const account = {username: input.username, passwordHash: await hashPassword(input.password)};
  const created = await db.query("INSERT INTO dashboard_metadata(name, value) VALUES ('auth_account', ?) ON CONFLICT(name) DO NOTHING", await seal(env.DASHBOARD_DATA_KEY, 'dashboard-auth', account)).run();
  if (!created.meta.changes) throw new ApiError(409, 'setup_already_completed');
  await db.audit('dashboard_initialized', {user: input.username});
  return {initialized: true};
}
