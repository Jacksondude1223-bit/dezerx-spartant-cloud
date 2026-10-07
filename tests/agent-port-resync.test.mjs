import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {signature} from '../workers/shared.js';

const id = 't-' + '3'.repeat(24);
const secret = 'd'.repeat(64);

async function listen(label) {
  const server = http.createServer((req, res) => res.end(label));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, label, port: server.address().port};
}
async function freePort() {
  const {server, port} = await listen('reserved');
  await new Promise(resolve => server.close(resolve));
  return port;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a Docker-reassigned tenant port is re-synced instead of serving 503 forever', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-port-'));
  const state = path.join(dir, 'docker.json');
  const before = await listen('tenant-before');
  const after = await listen('tenant-after');
  const reboot = await listen('tenant-reboot');
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  // Fake docker: `inspect` reports whatever port the state fixture currently claims,
  // which is how we simulate Docker handing the container a new ephemeral host port.
  await writeFile(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const file=process.env.FAKE_STATE;
if(args[0]==='inspect'){if(!fs.existsSync(file)){console.error('No such object');process.exit(1);} console.log(fs.readFileSync(file,'utf8'));}
if(args[0]==='pull'){console.log('pulled');}
if(args[0]==='run'){
 const labels={};
 for(const arg of args){const m=/^spartan\\.(fingerprint|tenant|role|managed)=(.*)$/.exec(arg); if(m) labels['spartan.'+m[1]]=m[2];}
 fs.writeFileSync(file,JSON.stringify([{Config:{Labels:labels},State:{Running:true},NetworkSettings:{Ports:{'8080/tcp':[{HostPort:process.env.FAKE_PORT}]}}}]));
 console.log('container');
}
`, {mode: 0o755});
  await writeFile(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n', {mode: 0o755});

  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_PORT: String(before.port),
    NODE_REGION: 'us', NODE_CONTROL_SECRET: secret, ORIGIN_SECRET: secret, BASE_DOMAIN: 'cloud.test',
    SPARTAN_IMAGE: `registry.test/spartan@sha256:${'a'.repeat(64)}`,
    US_ORIGIN: 'https://us.origin.test', DE_ORIGIN: 'https://de.origin.test', DATA_ROOT: path.join(dir, 'data')
  };
  const agents = [];
  const start = async () => {
    const agentPort = await freePort();
    const child = spawn(process.execPath, ['node/agent.mjs'], {cwd: path.resolve('.'), env: {...env, AGENT_PORT: String(agentPort)}});
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    agents.push(child);
    const origin = `http://127.0.0.1:${agentPort}`;
    for (let i = 0; i < 100; i++) {
      try { await fetch(`${origin}/__cloud_node_health`, {headers: {'x-spartan-origin': secret}}); return {origin, stderr: () => stderr}; }
      catch { await wait(20); }
    }
    throw new Error(`agent did not start: ${stderr}`);
  };
  const headers = {'x-spartan-origin': secret, 'x-spartan-host': `${id}.cloud.test`, 'x-spartan-client-ip': '198.51.100.7'};
  const savedPort = async () => JSON.parse(await readFile(path.join(dir, 'data', id, 'state.json'), 'utf8')).port;
  // Poll because the re-sync is triggered by a failed proxy attempt and runs out of band.
  const serve = async origin => {
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${origin}/tenant/${id}/billing`, {headers});
      if (response.ok) return response.text();
      await response.arrayBuffer();
      await wait(50);
    }
    return 'never-recovered';
  };

  try {
    let agent = await start();
    const body = JSON.stringify({id, primary: 'us', appKey: `base64:${Buffer.alloc(32).toString('base64')}`, url: `https://${id}.cloud.test`, fingerprint: 'a'.repeat(64)});
    const stamp = String(Date.now());
    const provision = await fetch(`${agent.origin}/control/provision`, {method: 'POST', body, headers: {'x-spartan-timestamp': stamp, 'x-spartan-signature': await signature(secret, stamp, 'POST', '/control/provision', body)}});
    assert.equal(provision.status, 200, agent.stderr());
    assert.equal((await provision.json()).status, 'ready');
    assert.equal(await serve(agent.origin), 'tenant-before');
    assert.equal(await savedPort(), before.port);

    // Docker restarts the container on its own (reboot, crash, OOM) and publishes a new
    // ephemeral host port. No control-plane call tells the agent about it.
    before.server.closeAllConnections();
    await new Promise(resolve => before.server.close(resolve));
    const fixture = JSON.parse(await readFile(state, 'utf8'));
    fixture[0].NetworkSettings.Ports['8080/tcp'][0].HostPort = String(after.port);
    await writeFile(state, JSON.stringify(fixture));

    assert.equal(await serve(agent.origin), 'tenant-after', agent.stderr());
    assert.equal(await savedPort(), after.port);

    // A restarted agent reconciles ports at startup, before any request fails.
    agents.pop().kill('SIGTERM');
    after.server.closeAllConnections();
    await new Promise(resolve => after.server.close(resolve));
    fixture[0].NetworkSettings.Ports['8080/tcp'][0].HostPort = String(reboot.port);
    await writeFile(state, JSON.stringify(fixture));
    agent = await start();
    for (let i = 0; i < 100 && await savedPort() !== reboot.port; i++) await wait(20);
    assert.equal(await savedPort(), reboot.port, agent.stderr());
    assert.equal(await serve(agent.origin), 'tenant-reboot', agent.stderr());
  } finally {
    for (const child of agents) child.kill('SIGTERM');
    await Promise.all(agents.map(child => child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : null));
    for (const {server} of [before, after, reboot]) await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});
