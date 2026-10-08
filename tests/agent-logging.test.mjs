import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {signature} from '../workers/shared.js';

const secret = 'l'.repeat(64);
const id = `t-${'5'.repeat(24)}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A failing provision must say why in the node log, because that log is the only
// diagnostic an operator has. But execFile puts the whole command line into
// error.message, and for mysql that line carries the tenant's database password, so the
// detail has to be redacted before it is written.
test('a failed provision logs a usable cause without leaking the database password', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-log-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  // Answers the readiness probe, then fails the provisioning statement with no stderr of
  // its own, which is what forces the agent to fall back to error.message.
  await writeFile(path.join(bin, 'mysql'), '#!/bin/sh\ncase "$*" in *"SELECT 1"*) echo 1; exit 0 ;; esac\nexit 1\n', {mode: 0o755});
  await writeFile(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  await writeFile(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const agentPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const agent = spawn(process.execPath, ['node/agent.mjs'], {cwd: path.resolve('.'), env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    NODE_REGION: 'us', NODE_CONTROL_SECRET: secret, ORIGIN_SECRET: secret, BASE_DOMAIN: 'cloud.test',
    SPARTAN_IMAGE: `registry.test/spartan@sha256:${'a'.repeat(64)}`, US_ORIGIN: 'https://us.test',
    DE_ORIGIN: 'https://de.test', DATA_ROOT: path.join(dir, 'data'), AGENT_PORT: String(agentPort)}});
  let stderr = '';
  agent.stderr.on('data', value => { stderr += value; });
  const origin = `http://127.0.0.1:${agentPort}`;
  try {
    for (let i = 0; i < 200; i++) { try { await fetch(`${origin}/__cloud_node_health`); break; } catch { await wait(20); } }
    const body = JSON.stringify({id, primary: 'us', appKey: `base64:${Buffer.alloc(32).toString('base64')}`, url: `https://${id}.cloud.test`, fingerprint: 'c'.repeat(64), licenseKey: 'SPARTANULTIMATE_kkkkkkkkkkkkkkkkkkkkkkkk'});
    const stamp = String(Date.now());
    const response = await fetch(`${origin}/control/provision`, {method: 'POST', body, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, 'POST', '/control/provision', body)}});
    assert.equal(response.status, 503, 'provisioning fails when the database cannot be prepared');
    assert.match(stderr, /request_failed/);
    assert.equal(/"detail":""/.test(stderr), false, 'the log must carry a cause, not just an exit code');
    // The password itself is generated inside the agent, so assert the invariant instead:
    // any credential clause that reaches the log is redacted.
    const clauses = stderr.match(/IDENTIFIED BY '[^']*'/g) || [];
    for (const clause of clauses) assert.equal(clause, "IDENTIFIED BY '<redacted>'", `leaked credential in log: ${clause}`);
    assert.equal(/Command failed:/.test(stderr), false, 'the raw command line is never logged');
  } finally {
    agent.kill('SIGTERM');
    await new Promise(resolve => agent.once('exit', resolve));
    await rm(dir, {recursive: true, force: true});
  }
});
