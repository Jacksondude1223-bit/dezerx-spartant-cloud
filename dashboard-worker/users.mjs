import {hashPassword, seal, open, random, equal} from './crypto.mjs';
import {ApiError} from './store.mjs';
const validUsername = value => typeof value === 'string' && /^[a-zA-Z0-9_.@-]{1,64}$/.test(value);
const sameUser = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const purpose = username => 'dashboard-user:' + username.toLowerCase();
async function decode(env, row) {
  const account = await open(env.DASHBOARD_DATA_KEY, purpose(row.username), row.record);
  if (account.username !== row.username || typeof account.enabled !== 'boolean' || !/^[a-f0-9]{32}$/.test(account.version || '') || typeof account.passwordHash !== 'string') throw new ApiError(503, 'invalid_user_record');
  return account;
}
export async function userCredentials(env, db, username) {
  if (!validUsername(username)) return null;
  if (sameUser(username, env.DASHBOARD_USER)) return env;
  const row = await db.query('SELECT * FROM dashboard_users WHERE username = ?', username).first();
  if (!row) return null;
  const account = await decode(env, row);
  if (!account.enabled) return null;
  return {...env, DASHBOARD_USER: account.username, DASHBOARD_PASSWORD_HASH: account.passwordHash, DASHBOARD_TOTP_SECRET: '', DASHBOARD_ACCOUNT_VERSION: account.version};
}
const publicUser = (row, account) => ({username: account.username, role: 'Administrator', owner: false, enabled: account.enabled, version: account.version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()});
export async function usersOperation(method, action, username, input, actor, env, db) {
  if (actor !== env.DASHBOARD_USER) throw new ApiError(403, 'user_management_forbidden');
  if (!action && method === 'GET') {
    const rows = await db.all('SELECT * FROM dashboard_users ORDER BY username LIMIT 100');
    return {users: [{username: env.DASHBOARD_USER, role: 'Primary administrator', owner: true, enabled: true, createdAt: null, updatedAt: null}, ...await Promise.all(rows.map(async row => publicUser(row, await decode(env, row))))]};
  }
  if (method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  if (!action) action = 'create';
  if (!['create', 'password', 'status', 'delete'].includes(action)) throw new ApiError(404, 'not_found');
  username = action === 'create' ? input.username : username;
  if (!validUsername(username)) throw new ApiError(400, 'invalid_username');
  if (sameUser(username, env.DASHBOARD_USER)) throw new ApiError(409, 'primary_admin_protected');
  if (['create', 'password'].includes(action) && (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 1024)) throw new ApiError(400, 'invalid_password');
  if (action === 'status' && typeof input.enabled !== 'boolean') throw new ApiError(400, 'invalid_input');
  const token = await db.lock('dashboard-users');
  if (!token) throw new ApiError(409, 'users_busy');
  try {
    const row = await db.query('SELECT * FROM dashboard_users WHERE username = ?', username).first();
    const now = Date.now();
    if (action === 'create') {
      if (row) throw new ApiError(409, 'username_in_use');
      const count = await db.query('SELECT COUNT(*) AS total FROM dashboard_users').first();
      if (count.total >= 100) throw new ApiError(409, 'user_limit');
      const account = {username, enabled: true, passwordHash: await hashPassword(input.password), version: random(16)};
      await db.query('INSERT INTO dashboard_users(username, record, created_at, updated_at) VALUES (?, ?, ?, ?)', username, await seal(env.DASHBOARD_DATA_KEY, purpose(username), account), now, now).run();
      await db.audit('dashboard_user_created', {user: actor, username});
      return publicUser({created_at: now, updated_at: now}, account);
    }
    if (!row) throw new ApiError(404, 'user_not_found');
    const account = await decode(env, row);
    if (!equal(input.version, account.version)) throw new ApiError(409, 'user_changed');
    if (action === 'password') account.passwordHash = await hashPassword(input.password);
    if (action === 'status') account.enabled = input.enabled;
    account.version = random(16);
    await db.db.batch([
      action === 'delete' ? db.query('DELETE FROM dashboard_users WHERE username = ?', row.username) : db.query('UPDATE dashboard_users SET record = ?, updated_at = ? WHERE username = ?', await seal(env.DASHBOARD_DATA_KEY, purpose(row.username), account), now, row.username),
      db.query('DELETE FROM dashboard_sessions WHERE username = ? COLLATE NOCASE', row.username)
    ]);
    await db.audit('dashboard_user_' + ({password: 'password_reset', status: account.enabled ? 'enabled' : 'disabled', delete: 'deleted'}[action]), {user: actor, username: row.username});
    return action === 'delete' ? {deleted: true} : publicUser({...row, updated_at: now}, account);
  } finally {await db.unlock('dashboard-users', token);}
}
