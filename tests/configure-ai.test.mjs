import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
test('configure generates Workers AI binding, shared secret, migration and signed node endpoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spartan-ai-config-'));
  const configure = new URL('../scripts/configure.mjs', import.meta.url).href;
  try {
    await writeFile(path.join(directory, '.env'), ['CLOUDFLARE_ACCOUNT_ID=account', 'CLOUDFLARE_ZONE_ID=zone', 'CLOUDFLARE_API_TOKEN=test-token', 'BASE_DOMAIN=cloud.spartan.test', 'US_HOSTNAME=us.spartan.test', 'DE_HOSTNAME=de.spartan.test', 'SPARTAN_IMAGE=registry/image@sha256:' + 'a'.repeat(64), 'AI_RECOVERY_ENABLED=true', 'AI_MAX_CALLS_PER_DAY=10'].join('\n'));
    await writeFile(path.join(directory, 'mock.mjs'), `globalThis.fetch = async (url, init) => {
      const resource = new URL(url).pathname;
      let result;
      if (resource.endsWith('/zones/zone')) result = {name: 'spartan.test'};
      else if (resource.endsWith('/workers/subdomain')) result = {subdomain: 'my-account'};
      else if (resource.endsWith('/cfd_tunnel')) result = {id: JSON.parse(init.body).name.includes('-us-') ? 'us-tunnel' : 'de-tunnel'};
      else if (resource.endsWith('/token')) result = 'tunnel-token';
      else if (resource.endsWith('/dns_records') || resource.endsWith('/queues')) result = init.method === 'GET' ? [] : {};
      else if (resource.endsWith('/configurations')) result = {};
      else throw new Error('unexpected_resource');
      return Response.json({success: true, result});
    };`);
    await exec(process.execPath, ['--import', path.join(directory, 'mock.mjs'), '--input-type=module', '-e', `await import(${JSON.stringify(configure)})`], {cwd: directory});
    const worker = JSON.parse(await readFile(path.join(directory, 'generated/provisioning.json'), 'utf8'));
    for (const [source, target] of [['provisioning.json', 'wrangler.toml'], ['routing.json', 'wrangler.routing.toml']]) {
      const expected = JSON.parse(await readFile(path.join(directory, 'generated', source), 'utf8'));
      expected.main = path.basename(expected.main);
      const {stdout} = await exec('python3', ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', path.join(directory, 'workers', target)]);
      assert.deepEqual(JSON.parse(stdout), expected);
      const toml = await readFile(path.join(directory, 'workers', target), 'utf8');
      assert.equal(toml.includes('test-token'), false);
      assert.equal(toml.includes('SECRET'), false);
    }
    const secrets = JSON.parse(await readFile(path.join(directory, 'generated/provisioning.secrets.json'), 'utf8'));
    assert.deepEqual(worker.ai, {binding: 'AI'});
    assert.equal(worker.vars.MAX_CUSTOM_HOSTNAMES, '30');
    assert.deepEqual(worker.triggers.crons, ['0 */6 * * *']);
    assert.ok(worker.durable_objects.bindings.some(binding => binding.name === 'RECOVERY' && binding.class_name === 'Recovery'));
    assert.deepEqual(worker.migrations.at(-1), {tag: 'v3', new_sqlite_classes: ['Recovery']});
    assert.equal(worker.vars.AI_MAX_CALLS_PER_DAY, '10');
    assert.match(secrets.AI_RECOVERY_SECRET, /^[a-f0-9]{64}$/);
    for (const region of ['us', 'de']) {
      const env = await readFile(path.join(directory, `generated/${region}.env`), 'utf8');
      assert.ok(env.includes('AI_RECOVERY_URL=https://spartan-provisioning.my-account.workers.dev/v1/recovery'));
      assert.ok(env.includes('AI_RECOVERY_SECRET=' + secrets.AI_RECOVERY_SECRET));
      assert.equal(env.includes('CLOUDFLARE_API_TOKEN'), false);
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});
