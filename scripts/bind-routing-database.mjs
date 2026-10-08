import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const id = process.argv[2] || process.env.CLOUDFLARE_D1_DATABASE_ID;
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || '')) throw new Error('existing_d1_database_id_required');
const directory = path.resolve('workers');
for (const file of ['wrangler.toml', 'wrangler.routing.toml']) {
  const filename = path.join(directory, file);
  const source = await readFile(filename, 'utf8');
  const existing = [...source.matchAll(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|$)/g)];
  if (existing.length && (existing.length !== 1 || !/^binding\s*=\s*"DB"\s*$/m.test(existing[0][1]))) throw new Error('unexpected_database_bindings');
  const base = source.match(/^BASE_DOMAIN\s*=\s*"([a-z0-9.-]+)"/m)?.[1];
  if (!base) throw new Error('base_domain_required');
  const name = `spartan-routing-${base.replace(/[^a-z0-9]+/g, '-')}`;
  const clean = source.replace(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|$)/g, '').trimEnd();
  await writeFile(filename, `${clean}\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${name}"\ndatabase_id = "${id}"\n`);
}
console.log('routing_database_bound');
