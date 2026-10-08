import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {signature} from '../workers/shared.js';
import routing from '../workers/routing.js';
import {d1} from './d1.mjs';
import {registerRoute, insertDomain, updateDomain} from '../workers/store.js';

test('node agent authenticates control requests and proxies only the correct tenant', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-test-'));
  const id = 't-' + '1'.repeat(24);
  const secret = 'b'.repeat(64);
  const requests = [];
  let licensedHost = `${id}.cloud.test`;
  const backend = http.createServer((req, res) => {
    requests.push({path: req.url, host: req.headers.host, credential: req.headers['x-spartan-origin'], clientIp: req.headers['x-spartan-client-ip'], forwarded: req.headers['x-forwarded-for'], ingress: req.headers['x-spartan-ingress-key']});
    if (req.url === '/__cloud_health' && req.headers.host !== licensedHost) { res.writeHead(403); res.end('license_domain_mismatch'); return; }
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
if(args[0]==='inspect'){if(!fs.existsSync(file)){console.error('No such object');process.exit(1);} console.log(fs.readFileSync(file,'utf8'));}
if(args[0]==='exec' && args.some(x=>x.endsWith('/cloud-create-admin'))){ process.stdin.resume(); let value=''; process.stdin.on('data', chunk=>value+=chunk); process.stdin.on('end', ()=>{const admin=JSON.parse(value); if(admin.email!=='owner@example.test'||admin.password!=='Chosen-password!') process.exit(1); fs.appendFileSync(process.env.ADMIN_CALLS,'created\\n');}); }
if(args[0]==='stop'||args[0]==='start'){const state=JSON.parse(fs.readFileSync(file,'utf8'));state[0].State.Running=args[0]==='start';fs.writeFileSync(file,JSON.stringify(state));}
if(args[0]==='rm'){fs.unlinkSync(file);}
if(args[0]==='run'){
 const label=args.find(x=>x.startsWith('spartan.fingerprint='));
 const result=[{Config:{Labels:{'spartan.fingerprint':label.split('=')[1], 'spartan.managed':'true', 'spartan.tenant':args.find(x=>x.startsWith('spartan.tenant=')).split('=')[1]}},State:{Running:true},NetworkSettings:{Ports:{'8080/tcp':[{HostPort:process.env.FAKE_PORT}]}}}];
 fs.writeFileSync(file,JSON.stringify(result));console.log('container');
}
`;
  await writeFile(path.join(bin, 'docker'), fake, {mode: 0o755});
  await writeFile(path.join(bin, 'chown'), '#!/bin/sh\ntest "$1" = -R && test "$2" = 33:33\n', {mode: 0o755});
  // Stubbed so the suite never reaches a real MariaDB: without this it silently
  // provisions databases on whatever host runs the tests.
  await writeFile(path.join(bin, 'mysql'), `#!/usr/bin/env node
const fs=require('node:fs');
const sql=process.argv[process.argv.length-1];
fs.appendFileSync(process.env.MYSQL_CALLS, sql + '\\n');
if (/^SELECT 1$/.test(sql)) console.log('1');
`, {mode: 0o755});
  const agent = spawn(process.execPath, ['node/agent.mjs'], {cwd: path.resolve('.'), env: {...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: path.join(dir, 'docker.json'), FAKE_PORT: String(backendPort), ADMIN_CALLS: path.join(dir, 'admin-calls'), MYSQL_CALLS: path.join(dir, 'mysql-calls'), NODE_REGION: 'us', NODE_CONTROL_SECRET: secret, ORIGIN_SECRET: secret, BASE_DOMAIN: 'cloud.test', SPARTAN_IMAGE: `registry.test/spartan@sha256:${'a'.repeat(64)}`, US_ORIGIN: 'https://us.origin.test', DE_ORIGIN: 'https://de.origin.test', DATA_ROOT: path.join(dir, 'data'), AGENT_PORT: String(agentPort)}});
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
    assert.equal((await fetch(`${origin}/__cloud_node_health`)).status, 401);
    const nodeHealth = await fetch(`${origin}/__cloud_node_health`, {headers: {'x-spartan-origin': secret}});
    assert.equal(nodeHealth.status, 200);
    assert.deepEqual(await nodeHealth.json(), {status: 'ready', region: 'us'});
    const license = 'SPARTANULTIMATE_kkkkkkkkkkkkkkkkkkkkkkkk';
    const input = {initialAdmin: {displayName: 'Owner', email: 'owner@example.test', password: 'Chosen-password!'}, id, primary: 'us', appKey: `base64:${Buffer.alloc(32).toString('base64')}`, url: `https://${id}.cloud.test`, fingerprint: 'a'.repeat(64), licenseKey: license};
    let body = JSON.stringify(input);
    assert.equal((await fetch(`${origin}/control/provision`, {method: 'POST', body})).status, 401);
    const send = async () => {
      const stamp = String(Date.now());
      return fetch(`${origin}/control/provision`, {method: 'POST', body, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, 'POST', '/control/provision', body)}});
    };
    body = JSON.stringify({...input, licenseKey: 'NOTASPARTANKEY_aaaaaaaaaaaaaaaa'});
    assert.equal((await send()).status, 503, 'an unrecognised licence tier is refused');
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
    const sqlCalls = await readFile(path.join(dir, 'mysql-calls'), 'utf8');
    assert.match(sqlCalls, /CREATE DATABASE IF NOT EXISTS `sp_1{24}`/, 'provisioning creates the tenant database');
    assert.match(sqlCalls, /CREATE USER IF NOT EXISTS 'sp_1{24}'@'localhost'/);
    assert.match(sqlCalls, /GRANT ALL PRIVILEGES ON `sp_1{24}`\.\* TO/);
    assert.match(sqlCalls, /MAX_USER_CONNECTIONS 20/);
    assert.ok(envFile.includes(`LICENSE_KEY=${license}`), 'the tenant carries the licence the vendor issued for it');
    assert.ok(envFile.includes('PRODUCT_ID=6'), 'the product id follows the licence tier');
    assert.equal(stderr.includes(license), false, 'the licence never reaches the log');
    assert.ok(JSON.parse(state).envHash, 'the environment is fingerprinted so a renewed licence can be detected');
    assert.equal(JSON.parse(state).envHash, JSON.parse(state).containerEnvHash, 'a freshly created container matches its environment');
    assert.ok(envFile.includes('DB_CONNECTION=mysql'), 'tenant runs on mysql');
    assert.ok(envFile.includes('DB_SOCKET=/run/mysqld/mysqld.sock'));
    assert.ok(envFile.includes(`DB_DATABASE=sp_${'1'.repeat(24)}`));
    assert.equal(envFile.includes('sqlite'), false, 'no sqlite configuration survives');
    assert.ok(JSON.parse(state).dbPassword.length >= 16, 'the node owns the database password');
    for (const value of [state, envFile, stderr]) { assert.equal(value.includes('Chosen-password!'), false); assert.equal(value.includes('owner@example.test'), false); }
    assert.equal(stderr.includes(JSON.parse(state).dbPassword), false, 'the database password never reaches the log');
    body = JSON.stringify({...input, url: 'https://panel.customer.test'});
    assert.equal((await send()).status, 200, 'a customer domain is a valid application URL');
    const moved = await readFile(path.join(dir, 'data', id, 'app.env'), 'utf8');
    assert.ok(moved.includes('APP_URL=https://panel.customer.test'), 'APP_URL is the customer domain');
    assert.ok(moved.includes('ASSET_URL=https://panel.customer.test'));
    const movedState = JSON.parse(await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8'));
    assert.equal(movedState.status, 'ready', 'a serving tenant is not taken offline to rewrite its environment');
    assert.equal(movedState.url, 'https://panel.customer.test');
    assert.notEqual(movedState.envHash, movedState.containerEnvHash, 'the new environment waits for an upgrade to recreate the container');
    for (const refused of ['https://cloud.test', 'https://us.origin.test', 'http://panel.customer.test', 'https://panel.customer.test/app', 'https://panel.customer.test:8443', 'panel.customer.test']) {
      body = JSON.stringify({...input, url: refused});
      assert.equal((await send()).status, 503, `refused application URL: ${refused}`);
    }
    body = JSON.stringify(input);
    assert.equal((await send()).status, 200, 'the routing subdomain stays a valid application URL');
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`)).status, 404);
    const headers = {'x-spartan-client-ip': '198.51.100.42', 'x-forwarded-for': 'attacker', 'cf-connecting-ip': 'attacker', 'x-real-ip': 'attacker', 'x-spartan-origin': secret, 'x-spartan-host': `${id}.cloud.test`};
    for (const clientIp of ['', '198.51.100.42, 203.0.113.9', 'invalid']) assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {headers: {...headers, 'x-spartan-client-ip': clientIp}})).status, 404);
    assert.equal((await fetch(`${origin}/tenant/${id}/%2eenv`, {headers})).status, 404);
    const proxy = await fetch(`${origin}/tenant/${id}/billing?invoice=1`, {headers});
    assert.equal(await proxy.text(), 'tenant-app');
    assert.equal(proxy.headers.get('set-cookie'), 'session=test; Secure; HttpOnly');
    assert.equal(proxy.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(requests.at(-1), {path: '/billing?invoice=1', host: `${id}.cloud.test`, credential: undefined, clientIp: '198.51.100.42', forwarded: '198.51.100.42', ingress: input.appKey});
    headers['x-spartan-host'] = `t-${'2'.repeat(24)}.cloud.test`;
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {headers})).status, 404);
    headers['x-spartan-host'] = 'billing.customer.test';
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {headers})).status, 404);
    headers['x-spartan-custom-domain'] = '1';
    const alias = await fetch(`${origin}/tenant/${id}/billing`, {headers, redirect: 'manual'});
    assert.equal(alias.status, 308);
    assert.equal(alias.headers.get('location'), `https://${id}.cloud.test/billing`);
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {method: 'POST', headers, body: 'payment=data', redirect: 'manual'})).status, 421);
    body = JSON.stringify({...input, url: 'https://panel.customer.test'});
    assert.equal((await send()).status, 200);
    const stagedState = JSON.parse(await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8'));
    assert.equal(stagedState.containerUrl, `https://${id}.cloud.test`);
    licensedHost = 'panel.customer.test';
    const upgradeBody = JSON.stringify({id, fingerprint: input.fingerprint});
    const upgradeStamp = String(Date.now());
    const upgraded = await fetch(`${origin}/control/upgrade`, {method: 'POST', body: upgradeBody, headers: {'x-spartan-timestamp': upgradeStamp, 'x-spartan-signature': await signature(secret, upgradeStamp, 'POST', '/control/upgrade', upgradeBody)}});
    assert.equal(upgraded.status, 200);
    assert.equal((await upgraded.json()).status, 'upgraded');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8')).containerUrl, 'https://panel.customer.test');
    headers['x-spartan-host'] = `${id}.cloud.test`;
    const canonical = await fetch(`${origin}/tenant/${id}/billing?invoice=1`, {headers, redirect: 'manual'});
    assert.equal(canonical.status, 308);
    assert.equal(canonical.headers.get('location'), 'https://panel.customer.test/billing?invoice=1');
    headers['x-spartan-host'] = 'panel.customer.test';
    const customerRequest = await fetch(`${origin}/tenant/${id}/billing`, {headers});
    assert.equal(await customerRequest.text(), 'tenant-app');
    assert.equal(requests.at(-1).host, 'panel.customer.test');
    assert.equal(requests.filter(req => req.path === '/__cloud_health').some(req => req.host === 'panel.customer.test'), true);
    const workerEnv = {BASE_DOMAIN: 'cloud.test', US_ORIGIN: 'https://us.origin.test', DE_ORIGIN: 'https://de.origin.test', ORIGIN_SECRET: secret, DB: d1()};
    await registerRoute(workerEnv, {id, serviceId: 'service_1', customerId: 'customer_1', primary: 'us', status: 'ready', lifecycleVersion: 0});
    await insertDomain(workerEnv, {hostname: licensedHost, tenantId: id, token: 'verified', status: 'active', nextCheckAt: 0});
    const actualFetch = globalThis.fetch;
    const nodeRequests = [];
    globalThis.fetch = async request => {
      nodeRequests.push({url: request.url, host: request.headers.get('x-spartan-host')});
      const nodeUrl = new URL(request.url);
      return actualFetch(`${origin}${nodeUrl.pathname}${nodeUrl.search}`, {method: request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, duplex: 'half', redirect: 'manual'});
    };
    try {
      for (const [country, node] of [['US', 'us'], ['DE', 'de'], ['BR', 'us'], ['FR', 'de']]) {
        const request = new Request('https://panel.customer.test/billing?invoice=7', {headers: {'cf-connecting-ip': '198.51.100.42', 'x-spartan-host': 'attacker.test', 'x-forwarded-host': 'attacker.test', authorization: 'Bearer customer-token'}});
        Object.defineProperty(request, 'cf', {value: {country}});
        const result = await routing.fetch(request, workerEnv);
        assert.equal(result.status, 200);
        assert.equal(await result.text(), 'tenant-app');
        assert.equal(nodeRequests.at(-1).url, `https://${node}.origin.test/tenant/${id}/billing?invoice=7`);
        assert.equal(nodeRequests.at(-1).host, 'panel.customer.test');
        assert.equal(requests.at(-1).host, 'panel.customer.test');
        assert.equal(requests.at(-1).clientIp, '198.51.100.42');
        assert.equal(result.headers.get('set-cookie'), 'session=test; Secure; HttpOnly');
      }
      const alternate = await routing.fetch(new Request(`https://${id}.cloud.test/billing?invoice=8`, {headers: {'cf-connecting-ip': '198.51.100.42'}}), workerEnv);
      assert.equal(alternate.status, 308);
      assert.equal(alternate.headers.get('location'), 'https://panel.customer.test/billing?invoice=8');
      const rejectedPost = await routing.fetch(new Request(`https://${id}.cloud.test/billing`, {method: 'POST', body: 'payment=data', headers: {'cf-connecting-ip': '198.51.100.42'}}), workerEnv);
      assert.equal(rejectedPost.status, 421);
      const forwardedCount = nodeRequests.length;
      await registerRoute(workerEnv, {id, serviceId: 'service_1', customerId: 'customer_1', primary: 'us', status: 'suspended', lifecycleVersion: 1});
      assert.equal((await routing.fetch(new Request('https://panel.customer.test/billing', {headers: {'cf-connecting-ip': '198.51.100.42'}}), workerEnv)).status, 403);
      assert.equal(nodeRequests.length, forwardedCount);
      await updateDomain(workerEnv, licensedHost, {status: 'pending_certificate'});
      assert.equal((await routing.fetch(new Request('https://panel.customer.test/billing', {method: 'POST', body: 'payment=data', headers: {'cf-connecting-ip': '198.51.100.42'}}), workerEnv)).status, 404);
      assert.equal(nodeRequests.length, forwardedCount);
    } finally { globalThis.fetch = actualFetch; }
    body = JSON.stringify(input);
    const lifecycle = async (action, lifecycleVersion) => {
      const payload = JSON.stringify({id, fingerprint: input.fingerprint, action, lifecycleVersion});
      const stamp = String(Date.now());
      return fetch(`${origin}/control/lifecycle`, {method: 'POST', body: payload, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, 'POST', '/control/lifecycle', payload)}});
    };
    assert.equal((await lifecycle('suspended', 1)).status, 200);
    assert.equal((await fetch(`${origin}/tenant/${id}/billing`, {headers})).status, 404);
    assert.equal((await send()).status, 503);
    body = JSON.stringify({...input, lifecycleVersion: 2});
    assert.equal((await send()).status, 200);
    assert.equal((await readFile(path.join(dir, 'admin-calls'), 'utf8')).trim(), 'created');
    assert.equal((await lifecycle('terminated', 3)).status, 200);
    body = JSON.stringify({...input, lifecycleVersion: 4});
    assert.equal((await send()).status, 503);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8')).status, 'terminated');
  } finally {
    agent.kill('SIGTERM');
    await new Promise(resolve => agent.once('exit', resolve));
    await new Promise(resolve => backend.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});
