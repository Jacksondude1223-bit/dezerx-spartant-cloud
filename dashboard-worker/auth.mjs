import {digest, random, equal, verifyPassword, totpCounter} from './crypto.mjs';
import {ApiError} from './store.mjs';
export const COOKIE = '__Host-spartan_dashboard';
export const cookie = (token, age) => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
export async function authVersion(env) {return digest([env.DASHBOARD_USER, env.DASHBOARD_PASSWORD_HASH, env.DASHBOARD_TOTP_SECRET || ''].join('\n'));}
export async function session(request, env, db) {
  const token = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  const row = await db.query('SELECT * FROM dashboard_sessions WHERE token_hash = ? AND expires > ?', await digest(token), Date.now()).first();
  return row && equal(row.auth_version, await authVersion(env)) ? row : null;
}
export async function login(request, input, env, db, config) {
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  for (const [key, window, maximum] of [['ip:' + await digest(ip), 15 * 60000, 10], ['global', 60000, 60]]) {
    const result = await db.query('INSERT INTO dashboard_rate_limits(key, count, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires <= ? THEN 1 ELSE count + 1 END, expires = CASE WHEN expires <= ? THEN excluded.expires ELSE expires END RETURNING count', key, now + window, now, now).first();
    if (result.count > maximum) throw new ApiError(429, 'too_many_attempts');
  }
  const userOk = equal(input.username, env.DASHBOARD_USER);
  const passOk = await verifyPassword(input.password, env.DASHBOARD_PASSWORD_HASH);
  const counter = env.DASHBOARD_TOTP_SECRET ? await totpCounter(env.DASHBOARD_TOTP_SECRET, input.code) : 0;
  if (!userOk || !passOk || counter === null) {
    await db.audit('login_failed', {ip});
    throw new ApiError(401, env.DASHBOARD_TOTP_SECRET ? 'invalid_credentials_or_code' : 'invalid_credentials');
  }
  if (env.DASHBOARD_TOTP_SECRET) {
    const key = await digest(env.DASHBOARD_TOTP_SECRET);
    const used = await db.query('INSERT INTO dashboard_totp(key, counter) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET counter = excluded.counter WHERE dashboard_totp.counter < excluded.counter RETURNING counter', key, counter).first();
    if (!used) throw new ApiError(401, 'invalid_credentials_or_code');
  }
  const token = random(), csrf = random(24);
  await db.query('INSERT INTO dashboard_sessions(token_hash, username, csrf, auth_version, expires) VALUES (?, ?, ?, ?, ?)', await digest(token), env.DASHBOARD_USER, csrf, await authVersion(env), now + config.hours * 3600000).run();
  await db.audit('login', {user: env.DASHBOARD_USER, ip});
  return {token, csrf};
}
export async function jsonBody(request, maximum = 65536) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'json_required');
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0, text = '';
  const decoder = new TextDecoder();
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {await reader.cancel(); throw new ApiError(413, 'body_too_large');}
    text += decoder.decode(value, {stream: true});
  }
  text += decoder.decode();
  let result;
  try {result = JSON.parse(text);} catch {throw new ApiError(400, 'invalid_json');}
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ApiError(400, 'invalid_input');
  return result;
}
