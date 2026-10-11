import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const ROUTING_DATABASE = '2551e490-663e-4fb7-b7b5-0fe468eca54a';
export function bindDashboard(config, id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) || id === ROUTING_DATABASE) throw new Error('A separate dashboard D1 database UUID is required; the routing database is forbidden');
  if (!config.includes('binding = "DASHBOARD_DB"') || config.includes('binding = "DB"')) throw new Error('Invalid dashboard D1 binding');
  return config.replace(/database_id\s*=\s*"[^"]+"/, 'database_id = "' + id + '"');
}
export function setupDatabase({configFile, run, databaseId} = {}) {
  const config = readFileSync(configFile, 'utf8');
  if (databaseId) {writeFileSync(configFile, bindDashboard(config, databaseId)); return databaseId;}
  const existing = config.match(/database_id\s*=\s*"([a-f0-9-]{36})"/)?.[1];
  if (existing) {bindDashboard(config, existing); return existing;}
  const listed = JSON.parse(run(['d1', 'list', '--json']));
  const matches = (Array.isArray(listed) ? listed : listed.result || []).filter(x => x.name === 'spartan-cloud-dashboard');
  if (matches.length > 1) throw new Error('Ambiguous dashboard D1 database; supply its UUID explicitly');
  if (matches.length === 1) {
    const id = matches[0].uuid || matches[0].id;
    writeFileSync(configFile, bindDashboard(config, id)); return id;
  }
  const output = run(['d1', 'create', 'spartan-cloud-dashboard']);
  const id = output.match(/database_id["\s:=]+"?([a-f0-9-]{36})/)?.[1];
  if (!id) throw new Error('D1 created or already exists. Run npm run setup -- YOUR_DASHBOARD_DATABASE_UUID after obtaining its ID from Cloudflare. Do not use the routing database.');
  writeFileSync(configFile, bindDashboard(config, id));
  return id;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const id = setupDatabase({configFile: path.join(root, 'wrangler.toml'), databaseId: process.argv[2], run: args => execFileSync(path.join(root, 'node_modules/.bin/wrangler'), args, {encoding: 'utf8', cwd: root})});
  console.log('Dashboard D1 bound: ' + id);
}
