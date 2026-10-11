import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {seal} from './crypto.mjs';
import {hostname} from './instances.mjs';
import {deployDashboard} from './deploy.mjs';
export async function importSql(source, key) {
  const records = JSON.parse(source).instances;
  if (!Array.isArray(records)) throw new Error('Expected the node dashboard instances.json file');
  const quote = value => value == null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
  const statements = [];
  for (const original of records) {
    if (!/^t-[a-f0-9]{24}$/.test(original.id || '') || !['us', 'de'].includes(original.primary) || !/^base64:[A-Za-z0-9+/]+=*$/.test(original.appKey || '') || !/^[a-f0-9]{64}$/.test(original.fingerprint || '')) throw new Error('Invalid legacy instance record');
    const item = structuredClone(original);
    if (item.hostname && !hostname(item.hostname)) throw new Error('Invalid legacy hostname');
    delete item.jobId; delete item.queue; delete item.operation; delete item.progress;
    if (['queued', 'deploying'].includes(item.status)) {
      item.status = 'failed'; item.error = 'dashboard_migrated';
      for (const name of Object.keys(item.steps || {})) if (item.steps[name] === 'running') item.steps[name] = 'failed';
    }
    const encrypted = await seal(key, 'instance:' + item.id, item);
    statements.push(`INSERT INTO dashboard_instances(id, hostname, record, revision, created_at) VALUES (${quote(item.id)}, ${quote(item.hostname)}, ${quote(encrypted)}, 0, ${Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : Date.now()}) ON CONFLICT(id) DO NOTHING;`);
  }
  return statements.join('\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.env.DASHBOARD_DATA_KEY) throw new Error('Usage: DASHBOARD_DATA_KEY supplied securely in the environment, node import.mjs /path/to/instances.json');
  const root = path.dirname(fileURLToPath(import.meta.url)), temp = mkdtempSync(path.join(tmpdir(), 'spartan-dashboard-import-'));
  try {
    await deployDashboard({verifyOnly: true, run: (args, capture) => execFileSync(path.join(root, 'node_modules/.bin/wrangler'), args, {cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'})});
    const file = path.join(temp, 'import.sql');
    writeFileSync(file, await importSql(readFileSync(process.argv[2], 'utf8'), process.env.DASHBOARD_DATA_KEY), {mode: 0o600});
    execFileSync(path.join(root, 'node_modules/.bin/wrangler'), ['d1', 'execute', 'DASHBOARD_DB', '--remote', '--file', file], {cwd: root, stdio: 'inherit'});
    console.log('Legacy dashboard records imported without replacing existing instance records or application keys.');
  } finally {rmSync(temp, {recursive: true, force: true});}
}
