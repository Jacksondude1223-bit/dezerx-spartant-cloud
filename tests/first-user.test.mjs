import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const id = 't-' + 'a'.repeat(24);
const filename = new URL('../scripts/create-first-user.sh', import.meta.url).pathname;
async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'spartan-admin-'));
  try {
    await mkdir(path.join(root, id, 'database'), {recursive: true});
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin/docker'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') {
  console.log(args[2].includes('spartan.role') ? process.env.ROLE : process.env.TENANT);
} else if (args.includes('-r')) {
  const exists = fs.existsSync(process.env.USERS);
  if (args.at(-1).includes('if ((new $model)') && exists) process.exit(10);
  if (args.at(-1).includes('if (!(new $model)') && !exists) process.exit(10);
} else {
  if (process.env.CREATE_FAIL === 'true') process.exit(1);
  fs.writeFileSync(process.env.USERS, 'created');
}
`, {mode: 0o755});
    const env = {...process.env, DATA_ROOT: root, PATH: `${root}/bin:${process.env.PATH}`, CALLS: `${root}/calls`, USERS: `${root}/users`, ROLE: 'primary', TENANT: id};
    await fn(root, env);
  } finally { await rm(root, {recursive: true, force: true}); }
}
test('first user script uses the interactive Artisan command once on the primary', async () => {
  await fixture(async (root, env) => {
    await exec('script', ['-q', '-e', '-c', `bash '${filename}' '${id}'`, '/dev/null'], {env});
    const before = await readFile(env.CALLS, 'utf8');
    const create = before.trim().split('\n').map(JSON.parse).find(args => args.includes('dx:user:create'));
    assert.deepEqual(create, ['exec', '-it', '--user', 'www-data', '--workdir', '/var/www/html', `spartan-${id}`, 'php', 'artisan', 'dx:user:create']);
    assert.ok(await readFile(path.join(root, id, 'database/.cloud-first-user-created'), 'utf8'));
    await exec('bash', [filename, id], {env});
    const after = (await readFile(env.CALLS, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(after.filter(args => args.includes('dx:user:create')).length, 1);
  });
});
test('secondary, mismatched tenant, existing user and failed creation cannot mark setup complete', async () => {
  for (const scenario of ['secondary', 'mismatch', 'existing', 'failure']) await fixture(async (root, env) => {
    if (scenario === 'secondary') env.ROLE = 'secondary';
    if (scenario === 'mismatch') env.TENANT = 't-' + 'b'.repeat(24);
    if (scenario === 'existing') await writeFile(env.USERS, 'existing');
    if (scenario === 'failure') env.CREATE_FAIL = 'true';
    await assert.rejects(exec('script', ['-q', '-e', '-c', `bash '${filename}' '${id}'`, '/dev/null'], {env}));
    await assert.rejects(readFile(path.join(root, id, 'database/.cloud-first-user-created')), {code: 'ENOENT'});
    const calls = (await readFile(env.CALLS, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(args => args.includes('dx:user:create')).length, scenario === 'failure' ? 1 : 0);
  });
});
