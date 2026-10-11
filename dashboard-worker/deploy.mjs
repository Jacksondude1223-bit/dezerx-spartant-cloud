import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {bindDashboard, setupDatabase} from './setup.mjs';
import {buildAssets} from './build.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
export const REQUIRED = {dashboard_metadata: ['name', 'value'], dashboard_sessions: ['token_hash', 'username', 'csrf', 'auth_version', 'expires'], dashboard_rate_limits: ['key', 'count', 'expires'], dashboard_totp: ['key', 'counter'], dashboard_instances: ['id', 'hostname', 'record', 'revision', 'created_at'], dashboard_jobs: ['id', 'tenant_id', 'kind', 'payload', 'status', 'stage', 'attempts', 'next_at', 'deadline', 'created_at'], dashboard_locks: ['name', 'token', 'expires'], dashboard_activity: ['id', 'time', 'event', 'details']};
const indexes = ['dashboard_sessions_expiry', 'dashboard_jobs_active_tenant', 'dashboard_jobs_due', 'dashboard_activity_time'];
export function verifySchema(results, migrations) {
  if (!Array.isArray(results) || results.some(x => !x.success || !Array.isArray(x.results))) throw new Error('Dashboard D1 verification failed');
  let i = 0;
  for (const [table, columns] of Object.entries(REQUIRED)) {
    if (columns.some(name => !results[i]?.results.some(x => x.name === name))) throw new Error('Dashboard schema missing columns in ' + table);
    const integers = ['count', 'counter', 'expires', 'revision', 'created_at', 'next_at', 'deadline', 'attempts'];
    for (const name of columns) {
      const column = results[i].results.find(x => x.name === name);
      const type = integers.includes(name) || (table === 'dashboard_activity' && name === 'id') ? 'INTEGER' : 'TEXT';
      if (column.type !== type) throw new Error('Dashboard schema column type mismatch: ' + table + '.' + name);
    }
    if (Number(results[i].results.find(x => x.name === columns[0])?.pk) !== 1) throw new Error('Dashboard schema primary key missing: ' + table);
    i++;
  }
  if (results[i++]?.results[0]?.value !== 'spartan-dashboard') throw new Error('Wrong dashboard database identity');
  const history = results[i++]?.results.map(x => x.name) || [];
  if (migrations.some(name => !history.includes(name))) throw new Error('Dashboard migrations not recorded');
  if (indexes.some(name => !results[i]?.results.some(x => x.name === name))) throw new Error('Dashboard indexes missing');
}
export const verificationSql = [...Object.keys(REQUIRED).map(table => `PRAGMA table_info('${table}')`), "SELECT value FROM dashboard_metadata WHERE name = 'application'", 'SELECT name FROM d1_migrations', "SELECT name FROM sqlite_schema WHERE type = 'index'"].join('; ');
export async function deployDashboard({run, config = readFileSync(path.join(root, 'wrangler.toml'), 'utf8'), build = buildAssets, verifyOnly = false, log = console.log} = {}) {
  const id = config.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
  bindDashboard(config, id);
  if (!verifyOnly) {log('Applying dashboard migrations to its separate remote D1 database.'); run(['d1', 'migrations', 'apply', 'DASHBOARD_DB', '--remote']);}
  const results = JSON.parse(run(['d1', 'execute', 'DASHBOARD_DB', '--remote', '--json', '--command', verificationSql], true));
  verifySchema(results, readdirSync(path.join(root, 'migrations')).filter(x => x.endsWith('.sql')));
  log('Dashboard D1 migrations and schema verified.');
  if (!verifyOnly) {await build(); run(['deploy']);}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = (args, capture = false) => execFileSync(path.join(root, 'node_modules/.bin/wrangler'), args, {cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'});
  if (!process.argv.includes('--verify-only')) setupDatabase({configFile: path.join(root, 'wrangler.toml'), databaseId: process.env.DASHBOARD_DATABASE_ID, run: args => run(args, true)});
  await deployDashboard({verifyOnly: process.argv.includes('--verify-only'), run});
}
