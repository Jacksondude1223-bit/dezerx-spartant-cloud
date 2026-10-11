import {random, seal, open} from './crypto.mjs';
export class ApiError extends Error {constructor(status, code) {super(code); this.status = status;}}
export function store(env) {
  if (!env.DASHBOARD_DB) throw new ApiError(503, 'dashboard_database_missing');
  const db = env.DASHBOARD_DB.withSession ? env.DASHBOARD_DB.withSession('first-primary') : env.DASHBOARD_DB;
  const query = (sql, ...values) => db.prepare(sql).bind(...values);
  const all = async (sql, ...values) => (await query(sql, ...values).all()).results;
  const find = async id => {
    const row = await query('SELECT record, revision FROM dashboard_instances WHERE id = ?', id).first();
    if (!row) throw new ApiError(404, 'instance_not_found');
    return {...await open(env.DASHBOARD_DATA_KEY, 'instance:' + id, row.record), revision: row.revision};
  };
  const encode = item => {const {revision, ...record} = item; return seal(env.DASHBOARD_DATA_KEY, 'instance:' + item.id, record);};
  const save = async item => {
    item.updatedAt = new Date().toISOString();
    const result = await query('UPDATE dashboard_instances SET record = ?, hostname = ?, revision = revision + 1 WHERE id = ? AND revision = ?', await encode(item), item.hostname, item.id, item.revision).run();
    if (!result.meta.changes) throw new ApiError(409, 'instance_busy');
    item.revision++;
  };
  const lock = async (name, ttl = 180000) => {
    const token = random(16), now = Date.now();
    const row = await query('INSERT INTO dashboard_locks(name, token, expires) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET token = excluded.token, expires = excluded.expires WHERE dashboard_locks.expires < ? RETURNING token', name, token, now + ttl, now).first();
    return row?.token === token ? token : null;
  };
  const unlock = (name, token) => query('DELETE FROM dashboard_locks WHERE name = ? AND token = ?', name, token).run();
  const audit = (event, details = {}) => query('INSERT INTO dashboard_activity(time, event, details) VALUES (?, ?, ?)', new Date().toISOString(), event, JSON.stringify(details)).run();
  const note = (item, text, tone = '') => {item.log = [...(item.log || []), {time: new Date().toISOString(), text, tone}].slice(-60);};
  const list = async () => {
    const rows = await all('SELECT id FROM dashboard_instances ORDER BY created_at DESC LIMIT 1000');
    return Promise.all(rows.map(row => find(row.id)));
  };
  const insert = async item => {
    try {await query('INSERT INTO dashboard_instances(id, hostname, record, created_at) VALUES (?, ?, ?, ?)', item.id, item.hostname, await encode(item), Date.now()).run(); item.revision = 0;}
    catch {throw new ApiError(409, 'hostname_in_use');}
  };
  const enqueue = async (item, kind, payload, stage, deadline = Date.now() + 30 * 60000) => {
    if (await query("SELECT id FROM dashboard_jobs WHERE tenant_id = ? AND status IN ('queued', 'running')", item.id).first()) throw new ApiError(409, 'instance_busy');
    const id = random(16);
    item.jobId = id; item.updatedAt = new Date().toISOString();
    const encoded = await encode(item);
    const results = await db.batch([
      query('UPDATE dashboard_instances SET record = ?, revision = revision + 1 WHERE id = ? AND revision = ?', encoded, item.id, item.revision),
      query("INSERT INTO dashboard_jobs(id, tenant_id, kind, payload, status, stage, next_at, deadline, created_at) SELECT ?, ?, ?, ?, 'queued', ?, ?, ?, ? FROM dashboard_instances WHERE id = ? AND revision = ? AND record = ?", id, item.id, kind, await seal(env.DASHBOARD_DATA_KEY, 'job:' + id, payload), stage, Date.now(), deadline, Date.now(), item.id, item.revision + 1, encoded)
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) throw new ApiError(409, 'instance_busy');
    item.revision++;
  };
  return {db, query, all, find, save, lock, unlock, audit, note, list, insert, encode, enqueue};
}
export function view(item) {
  return {id: item.id, primary: item.primary, secondary: item.secondary, hostname: item.hostname, custom: item.custom, url: 'https://' + item.hostname, product: item.product, licenseHint: item.licenseKey ? item.licenseKey.slice(0, item.licenseKey.indexOf('_') + 1) + '…' + item.licenseKey.slice(-4) : null, customerId: item.customerId, serviceId: item.serviceId, status: item.status, operation: item.operation || null, adminCreation: item.adminCreation || null, error: item.error || null, steps: item.steps || {}, dns: item.dns || null, log: item.log || [], progress: item.progress || null, queue: item.status === 'queued' ? item.queue || {position: 1, length: 1} : null, createdAt: item.createdAt, updatedAt: item.updatedAt, createdBy: item.createdBy};
}
