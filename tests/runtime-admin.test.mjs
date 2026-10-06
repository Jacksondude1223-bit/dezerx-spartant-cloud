import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('runtime automation handles real terminal prompts, confirmation, forced role and retries', async () => {
  const result = await promisify(execFile)('python3', ['tests/runtime_admin_test.py']);
  assert.match(result.stderr, /Ran 4 tests/);
  assert.match(result.stderr, /OK/);
});
