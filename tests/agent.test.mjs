import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {signature} from '../workers/shared.js';

test('node agent authenticates control requests and proxies only the correct tenant', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-test-'));
  const id = 't-' + '1'.repeat(24);
  const secret = 'b'.repeat(64);
  const requests = [];
  const backend = http.createServer((req, res) => {
    requests.push({path: req.url, host: req.headers.host, credential: req.headers['x-spartan-origin']});
    res.setHeader('set-cookie', 'session=test; Secure; HttpOnly');
    res.end(req.url === '/__cloud_health' ? '{"status":"ready"}' : 'tenant-app');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const agentPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  const fake = `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const file=process.env.FAKE_STATE;
if(args[0]==='inspect'){if(!fs.existsSync(file))process.exit(1); console.log(fs.readFileSync(file,'utf8'));}
if(args[0]==='exec' && args.some(x=>x.endsWith('/cloud-create-admin'))){ process.stdin.resume(); let value=''; process.stdin.on('data', chunk=>value+=chunk); process.stdin.on('end', ()=>{const admin=JSON.parse(value); if(admin.email!=='owner@example.test'||admin.password!=='Chosen-password!') process.exit(1); fs.appendFileSync(process.env.ADMIN_CALLS,'created\\n');}); }
if(args[0]==='run'){
 const label=args.find(x=>x.startsWith('spartan.fingerprint='));
 const result=[{Config:{Labels:{'spartan.fingerprint':label.split('=')[1]}},State:{Running:true},NetworkSettings:{Ports:{'8080/tcp':[{HostPort:process.env.FAKE_PORT}]}}}];
 fs.writeFileSync(file,JSON.stringify(result));console.log('container');
}
`;
  await writeFile(path.join(bin, 'docker'), fake, {mode: 0o755});
  await writeFile(path.join(bin, 'chown'), '#!/bin/sh\ntest "$1" = -R && test "$2" = 33:33\n', {mode: 0o755});
  const agent = spawn(process.execPath, ['node/agent.mjs'], {cwd: path.resolve('.'), env: {...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: path.join(dir, 'docker.json'), FAKE_PORT: String(backendPort), ADMIN_CALLS: path.join(dir, 'admin-calls'), NODE_REGION: 'us', NODE_CONTROL_SECRET: secret, ORIGIN_SECRET: secret, BASE_DOMAIN: 'cloud.test', SPARTAN_IMAGE: `registry.test/spartan@sha256:${'a'.repeat(64)}`, US_ORIGIN: 'https://us.origin.test', DE_ORIGIN: 'https://de.origin.test', DATA_ROOT: path.join(dir, 'data'), AGENT_PORT: String(agentPort)}});
  let stderr = '';
  agent.stderr.on('data', value => { stderr += value; });
  const origin = `http://127.0.0.1:${agentPort}`;
  try {
    let connected = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch(origin); connected = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(connected, true, stderr);
    const input = {initialAdmin: {displayName: 'Owner', email: 'owner@example.test', password: 'Chosen-password!'}, id, primary: 'us', appKey: `base64:${Buffer.alloc(32).toString('base64')}`, url: `https://${id}.cloud.test`, fingerprint: 'a'.repeat(64)};
    let body = JSON.stringify(input);
    assert.equal((await fetch(`${origin}/control/provision`, {method: 'POST', body})).status, 401);
    const send = async () => {
      const stamp = String(Date.now());
      return fetch(`${origin}/control/provision`, {method: 'POST', body, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, 'POST', '/control/provision', body)}});
    };
    body = JSON.stringify({...input, initialAdmin: {...input.initialAdmin, password: 'Different-password!'}});
    assert.equal((await send()).status, 503);
    const failedState = JSON.parse(await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8'));
    assert.equal(failedState.status, 'provisioning');
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {headers: {'x-spartan-origin': secret, 'x-spartan-host': `${id}.cloud.test`}})).status, 404);
    body = JSON.stringify(input);
    const response = await send();
    assert.equal(response.status, 200, stderr);
    assert.equal((await response.json()).status, 'ready');
    assert.equal((await send()).status, 200);
    assert.equal((await readFile(path.join(dir, 'admin-calls'), 'utf8')).trim(), 'created');
    const state = await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8');
    const envFile = await readFile(path.join(dir, 'data', id, 'app.env'), 'utf8');
    for (const value of [state, envFile, stderr]) { assert.equal(value.includes('Chosen-password!'), false); assert.equal(value.includes('owner@example.test'), false); }
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`)).status, 404);
    const headers = {'x-spartan-origin': secret, 'x-spartan-host': `${id}.cloud.test`};
    const proxy = await fetch(`${origin}/tenant/${id}/billing?invoice=1`, {headers});
    assert.equal(await proxy.text(), 'tenant-app');
    assert.equal(proxy.headers.get('set-cookie'), 'session=test; Secure; HttpOnly');
    assert.equal(proxy.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(requests.at(-1), {path: '/billing?invoice=1', host: `${id}.cloud.test`, credential: undefined});
    headers['x-spartan-host'] = `t-${'2'.repeat(24)}.cloud.test`;
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {headers})).status, 404);
    headers['x-spartan-host'] = 'billing.customer.test';
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {headers})).status, 404);
    headers['x-spartan-custom-domain'] = '1';
    const alias = await fetch(`${origin}/tenant/${id}/billing`, {headers});
    assert.equal(await alias.text(), 'tenant-app');
    assert.equal(requests.at(-1).host, 'billing.customer.test');
  } finally {
    agent.kill('SIGTERM');
    await new Promise(resolve => agent.once('exit', resolve));
    await new Promise(resolve => backend.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});
