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
  assert.equal(routing.assets, undefined);
  assert.deepEqual(routing.routes.map(route => route.pattern), ['load.dezerx.cloud/*', '*.load.dezerx.cloud/*', 'test.costallogic.co/*']);
  assert.equal('durable_objects' in routing, false);
  assert.deepEqual(routing.migrations, [{tag: 'routing-v1', new_sqlite_classes: ['RoutingTenant', 'Domains']}, {tag: 'routing-v2-d1-only', deleted_classes: ['RoutingTenant', 'Domains']}]);
  assert.equal(routing.d1_databases[0].binding, 'DB');
  assert.equal(routing.d1_databases[0].database_id, '2551e490-663e-4fb7-b7b5-0fe468eca54a');
  assert.equal('queues' in routing, false);
  assert.equal('ai' in routing, false);
  const provisioning = configs['wrangler.provisioning.toml'];
  assert.equal(provisioning.name, 'spartan-provisioning');
  assert.equal(provisioning.main, 'provisioning.js');
  assert.equal('account_id' in provisioning, false);
  assert.ok(provisioning.queues.consumers.length);
});
