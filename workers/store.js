// D1-backed store for routing records and custom-domain registrations.
//
// This replaces the RoutingTenant and Domains Durable Objects on the request hot path.
// A Durable Object is billed for the wall-clock time it stays awake, so consulting one
// per request kept one object warm per tenant (and one global object warm for every
// custom domain). D1 bills per row read, so the same lookups cost essentially nothing.
//
// The Durable Object classes are still exported for migration; see exportLegacy.

const ROUTE_COLUMNS = 'id, serviceId, customerId, primaryRegion, status, lifecycleVersion';
const DOMAIN_COLUMNS = 'hostname, tenantId, token, status, cloudflareId, createAttempted, certificateMethod, certificateStatus, cloudflareOwnership, certificateValidation, checkedAt, nextCheckAt, lastError';
const json = value => (value === null || value === undefined ? undefined : (() => { try { return JSON.parse(value); } catch { return undefined; } })());
const route = row => row && {id: row.id, serviceId: row.serviceId, customerId: row.customerId, primary: row.primaryRegion, status: row.status, lifecycleVersion: row.lifecycleVersion};
export const domain = row => row && {
  hostname: row.hostname, tenantId: row.tenantId, token: row.token, status: row.status,
  cloudflareId: row.cloudflareId ?? undefined, createAttempted: row.createAttempted === 1,
  certificateMethod: row.certificateMethod ?? undefined, certificateStatus: row.certificateStatus ?? undefined,
  cloudflareOwnership: json(row.cloudflareOwnership), certificateValidation: json(row.certificateValidation),
  checkedAt: row.checkedAt ?? undefined, nextCheckAt: row.nextCheckAt, lastError: row.lastError ?? undefined
};

export async function readRoute(env, id) {
  return route(await env.DB.prepare(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = ?`).bind(id).first());
}

// One statement is the whole decision: it inserts, or updates only when the change is
// permitted. That keeps the lifecycleVersion and termination rules atomic without a
// Durable Object's blockConcurrencyWhile. `updatedAt` is NULL only on a fresh insert,
// which is how a 201 is told apart from a 200.
export async function registerRoute(env, record) {
  const result = await env.DB.prepare(
    `INSERT INTO routes (id, serviceId, customerId, primaryRegion, status, lifecycleVersion, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       lifecycleVersion = excluded.lifecycleVersion,
       updatedAt = ?7
     WHERE routes.serviceId = excluded.serviceId
       AND routes.customerId = excluded.customerId
       AND routes.primaryRegion = excluded.primaryRegion
       AND (routes.status <> 'terminated' OR excluded.status = 'terminated')
       AND (excluded.lifecycleVersion > routes.lifecycleVersion
            OR (excluded.lifecycleVersion = routes.lifecycleVersion AND excluded.status = routes.status))
     RETURNING ${ROUTE_COLUMNS}, (updatedAt IS NULL) AS inserted`
  ).bind(record.id, record.serviceId, record.customerId, record.primary, record.status, record.lifecycleVersion, new Date().toISOString()).all();
  const row = result.results?.[0];
  if (row) return {record: route(row), created: Number(row.inserted) === 1};
  // The write above already decided. This read only chooses which error to report, so a
  // concurrent change can mislabel the reason but never corrupt state. Precedence matches
  // the Durable Object implementation: identity, then staleness, then termination.
  const previous = await readRoute(env, record.id);
  if (!previous || ['id', 'serviceId', 'customerId', 'primary'].some(key => previous[key] !== record[key])) return {error: 'service_conflict'};
  if (record.lifecycleVersion < previous.lifecycleVersion || (record.lifecycleVersion === previous.lifecycleVersion && record.status !== previous.status)) return {error: 'stale_operation'};
  if (previous.status === 'terminated' && record.status !== 'terminated') return {error: 'service_terminated'};
  return {error: 'stale_operation'};
}

export async function resolveHostname(env, hostname) {
  const row = await env.DB.prepare(`SELECT tenantId FROM domains WHERE hostname = ? AND status = 'active'`).bind(hostname).first();
  return row ? row.tenantId : null;
}
export async function readDomain(env, hostname) {
  return domain(await env.DB.prepare(`SELECT ${DOMAIN_COLUMNS} FROM domains WHERE hostname = ?`).bind(hostname).first());
}
export async function countDomains(env) {
  return (await env.DB.prepare('SELECT COUNT(*) AS total FROM domains').first()).total;
}
// Replaces the monotonic budgetUsed counter, which never decremented on delete and so
// locked the account out after 100 cumulative reservations. This counts slots actually
// held right now, so a delete frees one.
export async function countCloudflareSlots(env) {
  return (await env.DB.prepare('SELECT COUNT(*) AS total FROM domains WHERE cloudflareId IS NOT NULL OR createAttempted = 1').first()).total;
}
export async function insertDomain(env, record) {
  const result = await env.DB.prepare(
    `INSERT INTO domains (hostname, tenantId, token, status, nextCheckAt) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(hostname) DO NOTHING`
  ).bind(record.hostname, record.tenantId, record.token, record.status, record.nextCheckAt).run();
  return {record: await readDomain(env, record.hostname), created: (result.meta?.changes ?? 0) === 1};
}
// Single-statement lock replacing the Durable Object's serialisation: only the caller that
// flips createAttempted from 0 to 1 may create the Cloudflare custom hostname, so two
// concurrent verifies cannot both spend a hostname slot.
export async function claimCreateAttempt(env, hostname) {
  const result = await env.DB.prepare('UPDATE domains SET createAttempted = 1 WHERE hostname = ? AND createAttempted = 0').bind(hostname).run();
  return (result.meta?.changes ?? 0) === 1;
}
export async function updateDomain(env, hostname, patch) {
  const columns = ['status', 'cloudflareId', 'certificateMethod', 'certificateStatus', 'cloudflareOwnership', 'certificateValidation', 'checkedAt', 'nextCheckAt', 'lastError'].filter(key => key in patch);
  if (!columns.length) return readDomain(env, hostname);
  const values = columns.map(key => {
    const value = patch[key];
    if (value === undefined) return null;
    return ['cloudflareOwnership', 'certificateValidation'].includes(key) ? JSON.stringify(value) : value;
  });
  await env.DB.prepare(`UPDATE domains SET ${columns.map((key, index) => `${key} = ?${index + 1}`).join(', ')} WHERE hostname = ?${columns.length + 1}`).bind(...values, hostname).run();
  return readDomain(env, hostname);
}
export async function deleteDomain(env, hostname) {
  await env.DB.prepare('DELETE FROM domains WHERE hostname = ?').bind(hostname).run();
}
export async function dueDomains(env, now, limit = 3) {
  const result = await env.DB.prepare(`SELECT ${DOMAIN_COLUMNS} FROM domains WHERE status <> 'deleting' AND nextCheckAt <= ? ORDER BY nextCheckAt LIMIT ?`).bind(now, limit).all();
  return (result.results || []).map(domain);
}

// Migration only: writes a legacy Durable Object record verbatim. Existing rows win, so
// replaying the export is safe.
export async function importDomain(env, record) {
  const result = await env.DB.prepare(
    `INSERT INTO domains (hostname, tenantId, token, status, cloudflareId, createAttempted, certificateMethod, certificateStatus, cloudflareOwnership, certificateValidation, checkedAt, nextCheckAt, lastError)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ON CONFLICT(hostname) DO NOTHING`
  ).bind(
    record.hostname, record.tenantId, record.token, record.status, record.cloudflareId ?? null,
    record.createAttempted || record.slotReserved ? 1 : 0, record.certificateMethod ?? null, record.certificateStatus ?? null,
    record.cloudflareOwnership === undefined ? null : JSON.stringify(record.cloudflareOwnership),
    record.certificateValidation === undefined ? null : JSON.stringify(record.certificateValidation),
    record.checkedAt ?? null, record.nextCheckAt ?? 0, record.lastError ?? null
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}
