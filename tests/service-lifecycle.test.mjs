import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {applyLifecycle} from '../node/service-lifecycle.mjs';
const id = 't-' + 'a'.repeat(24);
const fingerprint = 'b'.repeat(64);
async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'spartan-lifecycle-'));
  try {
    await mkdir(path.join(root, id, 'database'), {recursive: true});
    await writeFile(path.join(root, id, 'database/database.sqlite'), 'keep-data');
    let record = {id, fingerprint, lifecycleVersion: 0, status: 'ready', appKey: 'keep-key'};
    let container = {Config: {Labels: {'spartan.fingerprint': fingerprint, 'spartan.tenant': id, 'spartan.managed': 'true'}}, State: {Running: true}};
    const calls = [];
    const deps = {root, load: async () => structuredClone(record), save: async value => { record = structuredClone(value); }, docker: async args => {
      calls.push(args);
      if (args[0] === 'inspect') { if (!container) throw Object.assign(new Error('missing'), {stderr: 'No such object'}); return JSON.stringify([container]); }
      if (args[0] === 'stop') container.State.Running = false;
      if (args[0] === 'rm') container = null;
      return '';
    }};
    await fn({deps, calls, record: () => record, container: () => container});
  } finally { await rm(root, {recursive: true, force: true}); }
}
test('suspension stops only the matching tenant and disables automatic Docker restart', async () => {
  await fixture(async ({deps, calls, record}) => {
    const result = await applyLifecycle({id, fingerprint, lifecycleVersion: 1, action: 'suspended'}, deps);
    assert.equal(result.status, 'suspended');
    assert.equal(record().status, 'suspended');
    assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(['update', '--restart=no', `spartan-${id}`])));
    assert.ok(calls.some(args => args[0] === 'stop' && args.at(-1) === `spartan-${id}`));
    assert.equal(calls.some(args => args[0] === 'rm'), false);
    await applyLifecycle({id, fingerprint, lifecycleVersion: 1, action: 'suspended'}, deps);
    assert.equal(calls.filter(args => args[0] === 'stop').length, 1);
  });
});
test('termination removes the container once and preserves database and tombstone on retries', async () => {
  await fixture(async ({deps, calls, record}) => {
    const input = {id, fingerprint, lifecycleVersion: 1, action: 'terminated'};
    await applyLifecycle(input, deps);
    await applyLifecycle(input, deps);
    assert.equal(calls.filter(args => args[0] === 'rm').length, 1);
    assert.deepEqual(calls.find(args => args[0] === 'rm'), ['rm', '--force', `spartan-${id}`]);
    assert.equal(await readFile(path.join(deps.root, id, 'database/database.sqlite'), 'utf8'), 'keep-data');
    assert.equal(record().status, 'terminated');
    await assert.rejects(applyLifecycle({...input, lifecycleVersion: 2, action: 'suspended'}, deps), /service_terminated/);
  });
});
test('stale versions, unsafe IDs and mismatched fingerprints cannot alter containers', async () => {
  await fixture(async ({deps, calls}) => {
    await applyLifecycle({id, fingerprint, lifecycleVersion: 2, action: 'suspended'}, deps);
    const count = calls.length;
    for (const input of [{id, fingerprint, lifecycleVersion: 1, action: 'terminated'}, {id: '../other', fingerprint, lifecycleVersion: 3, action: 'terminated'}, {id, fingerprint: 'c'.repeat(64), lifecycleVersion: 3, action: 'terminated'}]) await assert.rejects(applyLifecycle(input, deps));
    assert.equal(calls.length, count);
  });
});
test('unknown Docker failures do not pretend a container was removed', async () => {
  await fixture(async ({deps, record}) => {
    deps.docker = async () => { throw new Error('daemon unavailable'); };
    await assert.rejects(applyLifecycle({id, fingerprint, lifecycleVersion: 1, action: 'terminated'}, deps));
    assert.equal(record().status, 'ready');
  });
});
