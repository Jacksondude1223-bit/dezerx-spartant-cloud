import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const schema = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'schema.sql'), 'utf8');

// Minimal stand-in for a D1 binding, backed by the real SQLite engine so the tests
// exercise the actual SQL (upserts, conditional updates, RETURNING) rather than a mock.
export function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    async all() {
      const prepared = db.prepare(sql);
      if (/^\s*(insert|update|delete)/i.test(sql) && !/returning/i.test(sql)) {
        const info = prepared.run(...params);
        return {results: [], meta: {changes: Number(info.changes)}};
      }
      return {results: prepared.all(...params), meta: {changes: 0}};
    },
    async first() {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    async run() {
      const info = db.prepare(sql).run(...params);
      return {meta: {changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid)}};
    }
  });
  return {prepare: sql => statement(sql), _db: db};
}

// Writes a routing record directly, standing in for the operator publishing state to the
// router. Bypasses the compare-and-set on purpose; registerRoute has its own tests.
export function setRoute(env, record) {
  env.DB._db.prepare(`INSERT INTO routes (id, serviceId, customerId, primaryRegion, status, lifecycleVersion, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET status = excluded.status, lifecycleVersion = excluded.lifecycleVersion`)
    .run(record.id, record.serviceId ?? 'service_1', record.customerId ?? 'customer_1', record.primary ?? 'us', record.status, record.lifecycleVersion ?? 0);
}
export function setDomain(env, record) {
  env.DB._db.prepare(`INSERT INTO domains (hostname, tenantId, token, status, cloudflareId, createAttempted, nextCheckAt)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hostname) DO UPDATE SET status = excluded.status, cloudflareId = excluded.cloudflareId, nextCheckAt = excluded.nextCheckAt`)
    .run(record.hostname, record.tenantId, record.token ?? 'token', record.status, record.cloudflareId ?? null, record.createAttempted ? 1 : 0, record.nextCheckAt ?? 0);
}
export function readDomainRow(env, hostname) {
  return env.DB._db.prepare('SELECT * FROM domains WHERE hostname = ?').get(hostname) ?? null;
}
