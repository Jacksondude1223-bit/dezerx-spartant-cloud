import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const script = path.resolve('runtime/healthcheck.sh');

test('container health sends the licensed domain and refuses licensing and routing errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-health-'));
  try {
    const args = path.join(dir, 'args');
    await writeFile(path.join(dir, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HEALTH_ARGS"\nprintf "%s" "$HEALTH_STATUS"\nexit "${HEALTH_EXIT:-0}"\n', {mode: 0o755});
    const env = {...process.env, PATH: `${dir}:${process.env.PATH}`, APP_URL: 'https://billing.customer.test/', HEALTH_ARGS: args};
    for (const status of ['200', '204']) await exec('bash', [script], {env: {...env, HEALTH_STATUS: status}});
    const sent = (await readFile(args, 'utf8')).split('\n');
    assert.ok(sent.includes('Host: billing.customer.test'));
    assert.ok(sent.includes('http://127.0.0.1:8080/__cloud_health'));
    assert.ok(sent.includes('X-Forwarded-Proto: https'));
    for (const status of ['000', '301', '401', '403', '404', '429', '500', '502', '503', '504']) {
      await assert.rejects(exec('bash', [script], {env: {...env, HEALTH_STATUS: status}}));
    }
    await assert.rejects(exec('bash', [script], {env: {...env, HEALTH_STATUS: '200', HEALTH_EXIT: '7'}}));
    await assert.rejects(exec('bash', [script], {env: {...env, APP_URL: '', HEALTH_STATUS: '200'}}));
  } finally { await rm(dir, {recursive: true, force: true}); }
});
