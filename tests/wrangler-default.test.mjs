import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
test('default Cloudflare build selects routing and does not force a placeholder account', async () => {
  const {stdout} = await exec('python3', ['-c', 'import json,tomllib; print(json.dumps({name:tomllib.load(open("workers/"+name,"rb")) for name in ["wrangler.toml","wrangler.routing.toml","wrangler.provisioning.toml"]}))']);
  const configs = JSON.parse(stdout);
  assert.deepEqual(configs['wrangler.toml'], configs['wrangler.routing.toml']);
  const routing = configs['wrangler.toml'];
  assert.equal(routing.name, 'dezerx-spartant-cloud');
  assert.equal(routing.main, 'routing.js');
  assert.equal('account_id' in routing, false);
  assert.equal(routing.workers_dev, true);
  assert.deepEqual(routing.assets, {directory: 'public', binding: 'ASSETS', run_worker_first: true});
  assert.deepEqual(routing.routes.map(route => route.pattern), ['load.dezerx.cloud/*', '*.load.dezerx.cloud/*']);
  assert.deepEqual(routing.durable_objects.bindings, [{name: 'TENANTS', class_name: 'RoutingTenant'}, {name: 'DOMAINS', class_name: 'Domains'}]);
  assert.deepEqual(routing.migrations, [{tag: 'routing-v1', new_sqlite_classes: ['RoutingTenant', 'Domains']}]);
  assert.equal('queues' in routing, false);
  assert.equal('ai' in routing, false);
  const provisioning = configs['wrangler.provisioning.toml'];
  assert.equal(provisioning.name, 'spartan-provisioning');
  assert.equal(provisioning.main, 'provisioning.js');
  assert.equal('account_id' in provisioning, false);
  assert.ok(provisioning.queues.consumers.length);
});
