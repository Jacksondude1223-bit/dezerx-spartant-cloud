import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {signature} from '../workers/shared.js';

const secret = 'g'.repeat(64);
const id = `t-${'7'.repeat(24)}`;
const fingerprint = 'a'.repeat(64);
const OLD = `registry.test/spartan@sha256:${'1'.repeat(64)}`;
const NEW = `registry.test/spartan@sha256:${'2'.repeat(64)}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fake docker driven by a JSON state file, so the recreate, rollback and failure branches
// can be forced exactly. FAKE_PORTS is handed out one per `run`, which is how a real
// daemon reassigns the published port every time a container is created.
const DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_STATE;
fs.appendFileSync(process.env.DOCKER_CALLS, args.join(' ') + '\\n');
if (args[0] === 'inspect') {
  if (!fs.existsSync(file)) { console.error('Error: No such object: ' + args[args.length - 1]); process.exit(1); }
  if (args.indexOf('--format') !== -1) { console.log(''); process.exit(0); }
  console.log(fs.readFileSync(file, 'utf8'));
}
if (args[0] === 'pull' && process.env.FAIL_PULL === args[1]) { console.error('manifest unknown'); process.exit(1); }
if (args[0] === 'stop' && fs.existsSync(file)) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state[0].State.Running = false;
  fs.writeFileSync(file, JSON.stringify(state));
}
if (args[0] === 'rm' && fs.existsSync(file)) fs.unlinkSync(file);
if (args[0] === 'run') {
  const image = args[args.length - 1];
  if (process.env.FAIL_RUN_IMAGE === image) { console.error('oci runtime create failed'); process.exit(1); }
  const ports = process.env.FAKE_PORTS.split(',');
  const used = fs.existsSync(process.env.PORT_CURSOR) ? Number(fs.readFileSync(process.env.PORT_CURSOR, 'utf8')) : 0;
  fs.writeFileSync(process.env.PORT_CURSOR, String(used + 1));
  const assigned = ports[Math.min(used, ports.length - 1)];
  const labels = {'spartan.managed': 'true', 'spartan.tenant': process.env.FAKE_TENANT, 'spartan.role': 'primary', 'spartan.fingerprint': process.env.FAKE_FINGERPRINT};
  fs.writeFileSync(file, JSON.stringify([{Config: {Image: image, Labels: labels}, State: {Running: true}, NetworkSettings: {Ports: {'8080/tcp': assigned === 'dead' ? [{HostPort: '9'}] : [{HostPort: assigned}]}}}]));
  console.log('container');
}
`;

async function harness({image = NEW, status = 'ready', ports, failPull, failRunImage, containerImage = OLD, container = true} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-upgrade-'));
  const servers = [];
  const listening = [];
  for (const kind of ports) {
    if (kind === 'live') {
      const server = http.createServer((request, response) => response.end('{"status":"ready"}'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      listening.push(String(server.address().port));
    } else listening.push(kind);
  }
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), DOCKER, {mode: 0o755});
  await writeFile(path.join(bin, 'mysql'), '#!/bin/sh\ncase "$*" in *"SELECT 1"*) echo 1 ;; esac\nexit 0\n', {mode: 0o755});
  await writeFile(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const state = path.join(dir, 'docker.json');
  await writeFile(path.join(dir, 'calls'), '');
  const labels = {'spartan.managed': 'true', 'spartan.tenant': id, 'spartan.role': 'primary', 'spartan.fingerprint': fingerprint};
  await mkdir(path.join(dir, 'data', id, 'storage'), {recursive: true});
  await writeFile(path.join(dir, 'data', id, 'app.env'), 'APP_KEY=base64:x\n');
  await writeFile(path.join(dir, 'data', id, 'state.json'), JSON.stringify({id, primary: 'us', appKey: 'base64:x', url: `https://${id}.cloud.test`, fingerprint, role: 'primary', status, port: 1, image: containerImage, dbPassword: 'x'.repeat(32)}));
  if (container) await writeFile(state, JSON.stringify([{Config: {Image: containerImage, Labels: labels}, State: {Running: true}, NetworkSettings: {Ports: {'8080/tcp': [{HostPort: '1'}]}}}]));
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const agentPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const agent = spawn(process.execPath, ['node/agent.mjs'], {cwd: path.resolve('.'), env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_PORTS: listening.join(','),
    FAKE_TENANT: id, FAKE_FINGERPRINT: fingerprint, PORT_CURSOR: path.join(dir, 'cursor'), DOCKER_CALLS: path.join(dir, 'calls'),
    ...(failPull ? {FAIL_PULL: failPull} : {}), ...(failRunImage ? {FAIL_RUN_IMAGE: failRunImage} : {}),
    NODE_REGION: 'us', NODE_CONTROL_SECRET: secret, ORIGIN_SECRET: secret, BASE_DOMAIN: 'cloud.test',
    SPARTAN_IMAGE: image, US_ORIGIN: 'https://us.test', DE_ORIGIN: 'https://de.test',
    DATA_ROOT: path.join(dir, 'data'), AGENT_PORT: String(agentPort), UPGRADE_HEALTH_ATTEMPTS: '3'}});
  let stderr = '';
  agent.stderr.on('data', value => { stderr += value; });
  const origin = `http://127.0.0.1:${agentPort}`;
  for (let i = 0; i < 200; i++) { try { await fetch(`${origin}/__cloud_node_health`); break; } catch { await wait(20); } }
  return {
    origin, stderr: () => stderr,
    upgrade: async (body = {id, fingerprint}) => {
      const payload = JSON.stringify(body);
      const stamp = String(Date.now());
      const response = await fetch(`${origin}/control/upgrade`, {method: 'POST', body: payload, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, 'POST', '/control/upgrade', payload)}});
      return {status: response.status, body: await response.json()};
    },
    calls: async () => (await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n'),
    state: async () => JSON.parse(await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8')),
    liveImage: async () => JSON.parse(await readFile(state, 'utf8'))[0].Config.Image,
    stop: async () => {
      agent.kill('SIGTERM');
      await new Promise(resolve => agent.once('exit', resolve));
      for (const server of servers) await new Promise(resolve => server.close(resolve));
      await rm(dir, {recursive: true, force: true});
    }
  };
}

test('a tenant already on the target image is left alone', async () => {
  const harnessed = await harness({image: OLD, ports: ['live']});
  try {
    const result = await harnessed.upgrade();
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'current');
    assert.equal(result.body.image, OLD);
    const calls = await harnessed.calls();
    assert.equal(calls.some(call => /^(stop|rm|pull|run)/.test(call)), false, 'a no-op must not touch the container or the registry');
  } finally { await harnessed.stop(); }
});

test('a new image is pulled before the container is stopped, then recreated and re-registered', async () => {
  const harnessed = await harness({ports: ['live']});
  try {
    const result = await harnessed.upgrade();
    assert.equal(result.status, 200, harnessed.stderr());
    assert.equal(result.body.status, 'upgraded');
    assert.equal(result.body.previousImage, OLD);
    assert.equal(result.body.image, NEW);
    const ordered = (await harnessed.calls()).filter(call => /^(pull|stop|rm|run)/.test(call)).map(call => call.split(' ')[0]);
    assert.deepEqual(ordered, ['pull', 'stop', 'rm', 'run'], 'the pull must succeed before the tenant is stopped');
    assert.equal(await harnessed.liveImage(), NEW);
    const state = await harnessed.state();
    assert.equal(state.image, NEW, 'state records the image it now runs');
    assert.notEqual(state.port, 1, 'the reassigned host port is captured, not the stale one');
    assert.equal(state.dbPassword, 'x'.repeat(32), 'unrelated tenant state survives the upgrade');
  } finally { await harnessed.stop(); }
});

test('a pull failure leaves the tenant running the old image untouched', async () => {
  const harnessed = await harness({ports: ['live'], failPull: NEW});
  try {
    assert.equal((await harnessed.upgrade()).status, 503);
    const calls = await harnessed.calls();
    assert.equal(calls.some(call => /^(stop|rm)/.test(call)), false, 'never stop a tenant for an image that cannot be fetched');
    assert.equal(await harnessed.liveImage(), OLD);
    assert.equal((await harnessed.state()).image, OLD);
  } finally { await harnessed.stop(); }
});

test('a replacement that cannot start is rolled back to the previous image', async () => {
  const harnessed = await harness({ports: ['live'], failRunImage: NEW});
  try {
    const result = await harnessed.upgrade();
    assert.equal(result.status, 200, harnessed.stderr());
    assert.equal(result.body.status, 'rolled_back');
    assert.equal(result.body.image, OLD);
    assert.equal(result.body.attempted, NEW);
    assert.equal(await harnessed.liveImage(), OLD, 'the tenant is back on the image that works');
    assert.equal((await harnessed.state()).image, OLD);
    assert.match(harnessed.stderr(), /tenant_upgrade_rolled_back/);
  } finally { await harnessed.stop(); }
});

test('a replacement that starts but never reports healthy is not rolled back', async () => {
  // Its entrypoint reached migrate, so the schema may already be ahead of the old code.
  const harnessed = await harness({ports: ['dead']});
  try {
    const result = await harnessed.upgrade();
    assert.equal(result.status, 200, harnessed.stderr());
    assert.equal(result.body.status, 'provisioning');
    assert.equal(result.body.image, NEW);
    assert.equal(await harnessed.liveImage(), NEW, 'left on the new image rather than reverted behind its own migrations');
  } finally { await harnessed.stop(); }
});

test('upgrade refuses anything it cannot safely recreate', async () => {
  const harnessed = await harness({ports: ['live']});
  try {
    assert.equal((await harnessed.upgrade({id, fingerprint: 'b'.repeat(64)})).status, 503, 'wrong fingerprint');
    assert.equal((await harnessed.upgrade({id: `t-${'9'.repeat(24)}`, fingerprint})).status, 503, 'unknown tenant');
    assert.equal((await harnessed.upgrade({id, fingerprint: 'nope'})).status, 503, 'malformed fingerprint');
    const unsigned = await fetch(`${harnessed.origin}/control/upgrade`, {method: 'POST', body: JSON.stringify({id, fingerprint})});
    assert.equal(unsigned.status, 401, 'unsigned');
    assert.equal(await harnessed.liveImage(), OLD);
  } finally { await harnessed.stop(); }
});

for (const status of ['suspended', 'terminated']) {
  test(`a ${status} tenant is never upgraded`, async () => {
    const harnessed = await harness({ports: ['live'], status});
    try {
      assert.equal((await harnessed.upgrade()).status, 503);
      const calls = await harnessed.calls();
      assert.equal(calls.some(call => /^run/.test(call)), false, `recreating a ${status} tenant would silently restart it`);
      assert.equal(await harnessed.liveImage(), OLD);
    } finally { await harnessed.stop(); }
  });
}

test('a tenant with no container is reported rather than created by upgrade', async () => {
  const harnessed = await harness({ports: ['live'], container: false});
  try {
    assert.equal((await harnessed.upgrade()).status, 503);
    assert.equal((await harnessed.calls()).some(call => /^run/.test(call)), false, 'upgrade is not a provisioning path');
  } finally { await harnessed.stop(); }
});
