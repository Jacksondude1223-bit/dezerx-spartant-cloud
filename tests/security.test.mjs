import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecurity, sensitivePath} from '../node/security.mjs';
import routing from '../workers/routing.js';

test('sensitive-file blocking catches encoded probes and preserves customer application paths', () => {
  for (const value of ['/.env', '/.env.backup', '/%2eenv', '/%252eenv', '/.git/config', '/storage/container/.env', '/bootstrap/cache/config.php', '/backups/customer.tar', '/database.sql.gz', '/composer.lock', '/vendor/autoload.php', '/a/../secret', '/a%5cb', '/bad%zz']) assert.equal(sensitivePath(value), true, value);
  for (const value of ['/billing', '/api/invoices', '/downloads/invoice.pdf', '/storage/invoice.pdf', '/assets/main.js', '/vendor/livewire/livewire.js', '/billing?next=/.env']) assert.equal(sensitivePath(value), false, value);
});
test('control limits expire, reject overload and keep secrets out of audit records', () => {
  let time = 1000;
  const logs = [];
  const guard = createSecurity({now: () => time, log: row => logs.push(row), limit: 2});
  assert.equal(guard.allowed(), true);
  assert.equal(guard.allowed(), true);
  assert.equal(guard.allowed(), false);
  assert.equal(guard.denied(), true);
  assert.equal(guard.denied(), true);
  assert.equal(guard.denied(), false);
  guard.audit('control_completed', {id: `t-${'a'.repeat(24)}`, operation: 'provision', status: 'ready', password: 'secret-password', headers: {authorization: 'secret-token'}, body: 'secret-body', email: 'private@example.test'});
  const saved = JSON.stringify(logs);
  for (const secret of ['secret-password', 'secret-token', 'secret-body', 'private@example.test']) assert.equal(saved.includes(secret), false);
  time += 60000;
  assert.equal(guard.allowed(), true);
  assert.equal(guard.denied(), true);
});
test('Worker rejects sensitive files before database lookup or origin fetch', async () => {
  const env = {BASE_DOMAIN: 'cloud.test'};
  const request = new Request(`https://t-${'a'.repeat(24)}.cloud.test/%2eenv`, {headers: {'cf-connecting-ip': '198.51.100.7'}});
  const response = await routing.fetch(request, env);
  assert.equal(response.status, 404);
});
