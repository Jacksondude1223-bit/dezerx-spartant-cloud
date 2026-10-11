import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('WireGuard setup scopes database access, translates container traffic and refuses route collisions', async()=>{
  const result=await promisify(execFile)('python3',['tests/database_network_test.py']);
  assert.match(result.stderr,/Ran 14 tests/);
  assert.match(result.stderr,/OK/);
});
