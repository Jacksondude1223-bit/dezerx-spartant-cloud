import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const tables = {
  instance_hostnames: {hostname: ['TEXT', 0, 1], tenantId: ['TEXT', 1, 0], status: ['TEXT', 1, 0]},
  routes: {
    id: ['TEXT', 0, 1], serviceId: ['TEXT', 1, 0], customerId: ['TEXT', 1, 0],
    primaryRegion: ['TEXT', 1, 0], status: ['TEXT', 1, 0], lifecycleVersion: ['INTEGER', 1, 0], updatedAt: ['TEXT', 0, 0]
  },
  domains: {
    hostname: ['TEXT', 0, 1], tenantId: ['TEXT', 1, 0], token: ['TEXT', 1, 0], status: ['TEXT', 1, 0],
    cloudflareId: ['TEXT', 0, 0], createAttempted: ['INTEGER', 1, 0, '0'], certificateMethod: ['TEXT', 0, 0],
    certificateStatus: ['TEXT', 0, 0], cloudflareOwnership: ['TEXT', 0, 0], certificateValidation: ['TEXT', 0, 0],
    checkedAt: ['TEXT', 0, 0], nextCheckAt: ['INTEGER', 1, 0, '0'], lastError: ['TEXT', 0, 0]
  }
};
const indexes = {domains_due: 'nextCheckAt', domains_tenant: 'tenantId'};
export const verificationSql = [
  ...Object.keys(tables).map(table => `SELECT 'column' AS kind, '${table}' AS object, name, type, "notnull" AS required, pk, dflt_value AS defaultValue FROM pragma_table_info('${table}')`),
  ...Object.keys(indexes).map(index => `SELECT 'index' AS kind, '${index}' AS object, name, '' AS type, 0 AS required, 0 AS pk, NULL AS defaultValue FROM pragma_index_info('${index}') WHERE EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = '${index}' AND tbl_name = 'domains')`),
  `SELECT 'constraint' AS kind, 'instance_hostnames' AS object, c.name, '' AS type, 0 AS required, 0 AS pk, NULL AS defaultValue FROM pragma_index_list('instance_hostnames') AS i JOIN pragma_index_info(i.name) AS c WHERE i."unique" = 1 AND c.name = 'tenantId' AND (SELECT COUNT(*) FROM pragma_index_info(i.name)) = 1`,
  `SELECT 'migration' AS kind, '' AS object, name, '' AS type, 0 AS required, 0 AS pk, NULL AS defaultValue FROM d1_migrations`,
  `SELECT 'hostname' AS kind, '' AS object, hostname AS name, '' AS type, 0 AS required, 0 AS pk, NULL AS defaultValue FROM instance_hostnames WHERE status = 'active'`
].join(' UNION ALL ');

export function verifyDatabase(payload, migrations) {
  if (!Array.isArray(payload) || payload.length !== 1 || payload.some(result => result.success !== true || !Array.isArray(result.results))) throw new Error('D1 verification returned an invalid or unsuccessful response');
  const rows = payload.flatMap(result => result.results);
  for (const [table, columns] of Object.entries(tables)) {
    for (const [name, [type, required, pk, defaultValue = null]] of Object.entries(columns)) {
      const column = rows.find(row => row.kind === 'column' && row.object === table && row.name === name);
      if (!column || column.type?.toUpperCase() !== type || Number(column.required) !== required || Number(column.pk) !== pk || column.defaultValue !== defaultValue) throw new Error(`D1 schema mismatch: ${table}.${name}`);
    }
  }
  for (const [index, column] of Object.entries(indexes)) {
    const entries = rows.filter(row => row.kind === 'index' && row.object === index);
    if (entries.length !== 1 || entries[0].name !== column) throw new Error(`D1 index missing or invalid: ${index}`);
  }
  for (const migration of migrations) if (!rows.some(row => row.kind === 'migration' && row.name === migration)) throw new Error(`D1 migration not recorded: ${migration}`);
  if (rows.filter(row => row.kind === 'constraint' && row.object === 'instance_hostnames' && row.name === 'tenantId').length !== 1) throw new Error('D1 instance hostname tenant uniqueness missing');
}

function wrangler(args, capture = false) {
  return execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'wrangler', ...args], {
    cwd: directory, env: {...process.env, CI: 'true'}, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 16 * 1024 * 1024
  });
}

export function deployRouting({run = wrangler, verifyOnly = false, log = console.log} = {}) {
  const migrations = readdirSync(path.join(directory, 'migrations')).filter(name => name.endsWith('.sql')).sort();
  if (migrations.some(name => !/^\d+_.+\.sql$/.test(name))) throw new Error('D1 migrations must use numbered SQL filenames');
  if (!migrations.length) throw new Error('No D1 migration files found');
  const config = ['--config', path.join(directory, 'wrangler.toml')];
  if (!verifyOnly) {
    log('Applying pending migrations to remote D1 DB.');
    run(['d1', 'migrations', 'apply', 'DB', '--remote', ...config]);
  }
  log('Verifying remote D1 schema and migration history.');
  const payload = JSON.parse(run(['d1', 'execute', 'DB', '--remote', '--json', '--command', verificationSql, ...config], true));
  verifyDatabase(payload, migrations);
  log(`D1 verified: ${migrations.length} migration(s), required columns and indexes present.`);
  if (!verifyOnly) {
    const hostnames = payload.flatMap(result => result.results).filter(row => row.kind === 'hostname').map(row => row.name);
    if (hostnames.some(name => !/^instance-[1-9]\d{3}\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(name))) throw new Error('Invalid managed instance hostname');
    if (!hostnames.length) return run(['deploy', ...config]);
    const filename = path.join(directory, `.routing-deploy-${process.pid}.toml`);
    try {
      const text = readFileSync(path.join(directory, 'wrangler.toml'), 'utf8');
      writeFileSync(filename, text + hostnames.map(name => `\n[[routes]]\npattern = ${JSON.stringify(name)}\ncustom_domain = true\n`).join(''), {mode: 0o600});
      run(['deploy', '--config', filename]);
    } finally { try {unlinkSync(filename);} catch {} }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === '--verify-only')) throw new Error('Use deploy.mjs [--verify-only]');
    deployRouting({verifyOnly: args[0] === '--verify-only'});
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
