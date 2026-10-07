import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseEnvironment, serializeEnvironment, validateNodeEnvironment, checkNodeHealth} from '../scripts/setup-node.mjs';

const run = promisify(execFile);
const fixture = region => ({NODE_REGION: region, BASE_DOMAIN: 'cloud.customer.test', US_ORIGIN: 'https://node-us.customer.test', DE_ORIGIN: 'https://node-de.customer.test', SPARTAN_IMAGE: `registry.customer.test/spartan@sha256:${'a'.repeat(64)}`, NODE_CONTROL_SECRET: 'b'.repeat(64), ORIGIN_SECRET: 'c'.repeat(64), TENANT_CPUS: '1', TENANT_MEMORY: '512m', MAX_TENANTS: '100', AI_RECOVERY_ENABLED: 'false', AI_MAX_CALLS_PER_DAY: '10', AGENT_PORT: '8788', DATA_ROOT: '/srv/spartan-cloud', LARAVEL_ENV_FILE: '/etc/spartan-cloud/laravel-env.json'});

test('node configuration parser roundtrips literal values without executing shell syntax', () => {
  const env = {...fixture('us'), ORIGIN_SECRET: 'literal-$(touch /tmp/never-execute)-"\\' + 'x'.repeat(32)};
  assert.deepEqual(parseEnvironment(serializeEnvironment(env)), env);
  assert.equal(parseEnvironment('VALUE=$(never-execute)\n').VALUE, '$(never-execute)');
  assert.throws(() => parseEnvironment('KEY=value\nKEY=other\n'), /duplicate/);
  assert.throws(() => parseEnvironment('KEY="unterminated\n'), /quoted/);
  assert.throws(() => parseEnvironment('EnvironmentFile=oops\n'), /Invalid/);
});

test('node validation prevents routing loops, placeholders, weak credentials and region mismatches', () => {
  assert.equal(validateNodeEnvironment(fixture('us'), 'us').NODE_REGION, 'us');
  for (const patch of [
    {BASE_DOMAIN: 'cloud.example.com'}, {US_ORIGIN: 'http://us.customer.test'},
    {US_ORIGIN: 'https://node.cloud.customer.test'}, {DE_ORIGIN: 'https://node-us.customer.test'},
    {US_ORIGIN: 'https://user:pass@node-us.customer.test'}, {NODE_CONTROL_SECRET: 'short'},
    {ORIGIN_SECRET: 'CHANGE_ME'.repeat(8)}, {SPARTAN_IMAGE: 'registry.customer.test/spartan:latest'},
    {AGENT_PORT: '80'}, {NODE_REGION: 'de'}, {MAX_TENANTS: '0'}, {TENANT_CPUS: '0'},
    {TENANT_MEMORY: '512m\nExecStart=bad'}
  ]) assert.throws(() => validateNodeEnvironment({...fixture('us'), ...patch}, 'us'));
});

test('enabled AI recovery requires valid existing recovery endpoint and shared secret', () => {
  const env = {...fixture('de'), AI_RECOVERY_ENABLED: 'true', AI_RECOVERY_URL: 'https://recovery.customer.test/v1/recovery', AI_RECOVERY_SECRET: 'd'.repeat(64)};
  assert.equal(validateNodeEnvironment(env, 'de'), env);
  for (const patch of [{AI_RECOVERY_SECRET: ''}, {AI_RECOVERY_URL: 'http://recovery.customer.test/v1/recovery'}, {AI_RECOVERY_URL: 'https://recovery.customer.test/other'}, {AI_MAX_CALLS_PER_DAY: '21'}]) assert.throws(() => validateNodeEnvironment({...env, ...patch}, 'de'));
});

for (const region of ['us', 'de']) test(`noninteractive ${region} setup preserves shared credentials and protects files`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-setup-'));
  try {
    const envFile = path.join(dir, 'source.env');
    const tokenFile = path.join(dir, 'source.token');
    const dest = path.join(dir, 'config');
    const env = fixture(region);
    await writeFile(envFile, serializeEnvironment(env));
    await writeFile(tokenFile, 'synthetic-tunnel-token-for-offline-tests\n');
    const invoke = () => run(process.execPath, ['scripts/setup-node.mjs', region, '--non-interactive', '--env', envFile, '--token', tokenFile, '--output', dest]);
    for (let i = 0; i < 2; i++) {
      const output = await invoke();
      assert.equal(output.stdout.includes(env.ORIGIN_SECRET), false);
      assert.equal(output.stdout.includes('synthetic-tunnel-token'), false);
      assert.deepEqual(parseEnvironment(await readFile(path.join(dest, 'node.env'), 'utf8')), env);
      for (const name of ['node.env', 'tunnel-token', 'image']) assert.equal((await stat(path.join(dest, name))).mode & 0o777, 0o600);
      assert.equal((await stat(dest)).mode & 0o777, 0o700);
      assert.equal(await readFile(path.join(dest, 'image'), 'utf8'), env.SPARTAN_IMAGE + '\n');
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('invalid node inputs fail before producing configuration files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-setup-invalid-'));
  try {
    const envFile = path.join(dir, 'source.env');
    const tokenFile = path.join(dir, 'source.token');
    const dest = path.join(dir, 'config');
    await writeFile(envFile, serializeEnvironment(fixture('us')));
    await writeFile(tokenFile, 'invalid\n');
    await assert.rejects(run(process.execPath, ['scripts/setup-node.mjs', 'de', '--non-interactive', '--env', envFile, '--token', tokenFile, '--output', dest]), /another region/);
    await assert.rejects(run(process.execPath, ['scripts/setup-node.mjs', 'us', '--non-interactive', '--env', envFile, '--token', tokenFile, '--output', dest]), /CLOUDFLARE_TUNNEL_TOKEN/);
    await assert.rejects(stat(dest), {code: 'ENOENT'});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('readiness requires the correct authenticated agent and a connected tunnel', async () => {
  const env = fixture('us');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    return url.endsWith('/ready') ? new Response('', {status: 200}) : Response.json({status: 'ready', region: 'us'});
  };
  assert.equal(await checkNodeHealth(env, {fetchImpl, attempts: 1}), true);
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/__cloud_node_health');
  assert.equal(calls[0].options.headers['x-spartan-origin'], env.ORIGIN_SECRET);
  assert.equal(calls[1].url, 'http://127.0.0.1:8789/ready');
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls.every(call => call.options.redirect === 'error'), true);
  for (const [agentRegion, tunnelStatus] of [['de', 200], ['us', 503]]) {
    await assert.rejects(checkNodeHealth(env, {attempts: 1, fetchImpl: async url => url.endsWith('/ready') ? new Response('', {status: tunnelStatus}) : Response.json({status: 'ready', region: agentRegion})}), /readiness/);
  }
});
