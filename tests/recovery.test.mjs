import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {diagnose, permitted, chooseRepair, createRecovery} from '../node/recovery.mjs';

const config = {GEMINI_RECOVERY_ENABLED: 'true', GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_API_KEY: 'private-key', SPARTAN_IMAGE: 'registry/image@sha256:' + 'a'.repeat(64)};
const response = decision => Response.json({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify(decision)}]}}]});
test('diagnostics expose only categories and numeric container state', () => {
  const value = diagnose('health', {message: 'password=secret client@example.com', stderr: 'Permission denied token=private'}, 'APP_KEY=base64:secret', {exists: true, running: false, exitCode: 1, customer: 'private'});
  assert.deepEqual(value.signals, ['permissions']);
  for (const secret of ['password', 'secret', 'example.com', 'APP_KEY', 'private']) assert.equal(JSON.stringify(value).includes(secret), false);
});
test('Gemini receives no logs and can select only predefined repairs', async () => {
  const diagnostic = diagnose('health', {message: 'Permission denied PASSWORD=secret'});
  const choice = await chooseRepair(config, diagnostic, async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    assert.equal(init.headers['x-goog-api-key'], 'private-key');
    assert.equal(init.body.includes('secret'), true);
    const payload = JSON.parse(init.body);
    const input = JSON.parse(payload.contents[0].parts[0].text);
    assert.equal(JSON.stringify(input).includes('PASSWORD'), false);
    assert.equal(JSON.stringify(input).includes('secret'), false);
    assert.ok(input.allowedActions.includes('repair_permissions'));
    return response({action: 'repair_permissions', confidence: 0.95});
  });
  assert.equal(choice.action, 'repair_permissions');
});
test('injected commands, arbitrary actions and low-confidence answers never execute', async () => {
  for (const value of [{action: 'repair_permissions', confidence: 0.99, command: 'rm -rf /'}, {action: 'execute', confidence: 1}, {action: 'repair_permissions', confidence: 0.3}, {action: 'restart_container', confidence: 0.99}]) {
    const choice = await chooseRepair(config, diagnose('prepare', {message: 'Permission denied'}), async () => response(value));
    assert.equal(choice.action, 'manual');
  }
});
test('rate limits stop API use without paid models or alternate-provider fallbacks', async () => {
  let calls = 0;
  const result = await chooseRepair(config, diagnose('pull', {message: 'TLS handshake timeout'}), async () => { calls++; return new Response('', {status: 429}); });
  assert.equal(result.status, 'rate_limited');
  assert.equal(calls, 1);
});
test('unconfirmed free tier disables Gemini calls', async () => {
  const result = await chooseRepair({...config, GEMINI_FREE_TIER_CONFIRMED: 'false'}, diagnose('pull', {}), async () => assert.fail('must_not_call'));
  assert.equal(result.status, 'disabled');
});
test('disk, migration, dependencies and memory failures require manual intervention', () => {
  for (const message of ['No space left on device', 'migration failed', 'could not find driver', 'out of memory']) assert.equal(permitted(diagnose('health', {message}, '', {exists: true, running: true}), 'restart_container'), false);
});
test('repairs remain tenant-scoped with persistent attempt and daily budget limits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spartan-recovery-'));
  const id = 't-' + 'a'.repeat(24);
  const dir = path.join(root, id);
  const commands = [];
  let now = 1000000;
  let calls = 0;
  try {
    await mkdir(dir);
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({id, fingerprint: 'f', status: 'provisioning'}));
    const recovery = createRecovery({config: {...config, GEMINI_MAX_CALLS_PER_DAY: '2'}, root, now: () => now, docker: async args => { commands.push(args); if (args[0] === 'inspect') return JSON.stringify([{Config: {Labels: {'spartan.fingerprint': 'f'}}, State: {Running: true, ExitCode: 0}}]); if (args[0] === 'logs') return 'permission denied'; return ''; }, run: async (cmd, args) => { commands.push([cmd, ...args]); }, transport: async () => { calls++; return response({action: 'repair_permissions', confidence: 0.99}); }});
    assert.equal(await recovery.recover(id, 'health', new Error('permission denied')), true);
    assert.equal(await recovery.recover(id, 'health', new Error('permission denied')), false);
    now += 61000;
    assert.equal(await recovery.recover(id, 'health', new Error('permission denied')), true);
    now += 61000;
    assert.equal(await recovery.recover(id, 'health', new Error('permission denied')), false);
    assert.equal(calls, 2);
    assert.ok(commands.some(args => args[0] === 'chown' && args.at(-1) === `${dir}/storage`));
    assert.equal(commands.some(args => args.includes('rm') || args.includes('prune') || args.includes('migrate:fresh')), false);
    const history = JSON.parse(await readFile(path.join(dir, 'recovery.json')));
    assert.equal(history.attempts, 2);
    assert.equal(history.events.length, 2);
    assert.equal(history.events[0].outcome, 'applied');
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({id, status: 'ready'}));
    assert.equal(await recovery.recover(id, 'health', new Error('permission denied')), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});
