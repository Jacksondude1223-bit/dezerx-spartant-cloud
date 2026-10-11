import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {spawn, execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {signature} from '../workers/shared.js';
import {parseSize, parsePair, parseStats, tenantSummary, validContainerPath, validFsRequest, validExecRequest, planOf} from '../node/admin.mjs';

const id = 't-' + 'a'.repeat(24);
const fingerprint = 'f'.repeat(64);
const originSecret = 'o'.repeat(64);
const adminSecret = 'm'.repeat(64);

test('admin parsers convert docker figures to bytes and percentages', () => {
  assert.equal(parseSize('48.5MiB'), Math.round(48.5 * 1024 ** 2));
  assert.equal(parseSize('1.2kB'), 1200);
  assert.equal(parseSize('0B'), 0);
  assert.equal(parseSize('garbage'), null);
  assert.deepEqual(parsePair('1.2kB / 648B'), [1200, 648]);
  const stats = parseStats(JSON.stringify({Name: `spartan-${id}`, CPUPerc: '12.50%', MemUsage: '48.5MiB / 2GiB', MemPerc: '2.37%', NetIO: '1.2kB / 648B', BlockIO: '4.1MB / 0B', PIDs: '17'}));
  assert.equal(stats.cpuPercent, 12.5);
  assert.equal(stats.memoryLimitBytes, 2 * 1024 ** 3);
  assert.equal(stats.processes, 17);
  assert.equal(planOf('SPARTANCLOUDPLUS_abc'), 'cloudplus');
});

test('tenant summaries never expose keys or database passwords', () => {
  const summary = tenantSummary({id, fingerprint, appKey: 'base64:secret', licenseKey: 'SPARTANPROFESSIONAL_secret', dbPassword: 'secret', status: 'ready', role: 'primary', primary: 'us', url: 'https://x.test', envHash: 'a', containerEnvHash: 'b'});
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(summary.plan, 'professional');
  assert.equal(summary.environmentPending, true);
});

test('admin request validation rejects unsafe paths, users and modes', () => {
  for (const value of ['/', '/var/www/html', '/a b/c.txt']) assert.equal(validContainerPath(value), true, value);
  for (const value of ['relative', '/a/../b', '/a//b', '/a/', '/a\nb', '/a/./b', '', 5]) assert.equal(validContainerPath(value), false, String(value));
  assert.throws(() => validFsRequest({action: 'format', path: '/x'}), /invalid_file_request/);
  assert.throws(() => validFsRequest({action: 'list', path: '/x', user: 'admin'}), /invalid_user/);
  assert.throws(() => validFsRequest({action: 'chmod', path: '/x', mode: '999'}), /invalid_mode/);
  assert.throws(() => validFsRequest({action: 'chown', path: '/x', owner: 'root; rm -rf /'}), /invalid_owner/);
  assert.throws(() => validFsRequest({action: 'upload', path: '/x', contentBase64: 'AA==', uploadId: 'short', offset: 0, final: true}), /invalid_upload/);
  assert.throws(() => validFsRequest({action: 'rename', path: '/x', destination: '/'}), /invalid_destination/);
  assert.doesNotThrow(() => validFsRequest({action: 'chown', path: '/x', owner: 'www-data:www-data', recursive: true}));
  assert.throws(() => validExecRequest({command: ''}), /invalid_command/);
  assert.throws(() => validExecRequest({command: 'ls', timeoutSeconds: 600}), /invalid_timeout/);
  assert.throws(() => validExecRequest({command: 'ls', cwd: 'tmp'}), /invalid_cwd/);
});

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Docker stand-in: "exec" runs the requested program locally, so the file manager and
// console programs are exercised for real against a temporary directory.
const fakeDocker = `#!/usr/bin/env node
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(process.env.FAKE_STATE,'utf8'));
const log=value=>fs.appendFileSync(process.env.EXEC_LOG,JSON.stringify(value)+'\\n');
if(args[0]==='info'){console.log('29.0');process.exit(0);}
if(args[0]==='inspect'){console.log(JSON.stringify([{Config:{Image:'registry.test/spartan@sha256:'+'a'.repeat(64),Labels:{'spartan.managed':'true','spartan.tenant':state.id,'spartan.fingerprint':state.fingerprint}},State:{Running:state.running,Status:state.running?'running':'exited',StartedAt:'2026-10-11T10:00:00Z',ExitCode:0},RestartCount:2,Created:'2026-10-10T10:00:00Z',NetworkSettings:{Ports:{'8080/tcp':[{HostPort:String(state.port)}]}}}]));process.exit(0);}
if(args[0]==='ps'){console.log(JSON.stringify({Names:'spartan-'+state.id,State:state.running?'running':'exited',Status:'Up 2 hours',Image:'img',CreatedAt:'2026-10-10'}));console.log(JSON.stringify({Names:'unrelated',State:'running'}));process.exit(0);}
if(args[0]==='stats'){console.log(JSON.stringify({Name:'spartan-'+state.id,CPUPerc:'12.50%',MemUsage:'48.5MiB / 2GiB',MemPerc:'2.37%',NetIO:'1.2kB / 648B',BlockIO:'4.1MB / 0B',PIDs:'17'}));process.exit(0);}
if(args[0]==='logs'){console.log('2026-10-11T10:00:01.000000000Z out-line');console.error('2026-10-11T10:00:00.500000000Z err-line');process.exit(0);}
if(['start','stop','restart'].includes(args[0])){log({power:args[0]});process.exit(0);}
if(args[0]==='exec'){
  let i=1;const options=[];
  while(args[i].startsWith('-')){if(['--user','-e','-w'].includes(args[i])){options.push(args[i],args[i+1]);i+=2;}else{options.push(args[i]);i++;}}
  const command=args.slice(i+1);
  log({options,program:command[0]});
  if(command[0]==='php'){process.exit(0);}
  const result=spawnSync(command[0],command.slice(1),{stdio:'inherit'});
  process.exit(result.status===null?137:result.status);
}
process.exit(1);
`;

async function startAgent({env = {}, region = 'us'} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-admin-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), fakeDocker, {mode: 0o755});
  await writeFile(path.join(bin, 'mysql'), "#!/bin/sh\necho 1\n", {mode: 0o755});
  const data = path.join(dir, 'data');
  await mkdir(path.join(data, id, 'storage'), {recursive: true});
  await writeFile(path.join(data, id, 'storage', 'blob'), 'x'.repeat(1000));
  const agentPort = await freePort();
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({id, fingerprint, running: true, port: await freePort()}));
  const record = {id, fingerprint, primary: 'us', role: region === 'us' ? 'primary' : 'secondary', status: 'ready', url: `https://${id}.cloud.test`, image: 'registry.test/spartan@sha256:' + 'a'.repeat(64), port: 1, appKey: 'base64:topsecret', licenseKey: 'SPARTANPROFESSIONAL_topsecret', dbPassword: 'topsecret', lifecycleVersion: 3};
  await writeFile(path.join(data, id, 'state.json'), JSON.stringify(record));
  const agent = spawn(process.execPath, ['node/agent.mjs'], {cwd: path.resolve('.'), env: {...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: path.join(dir, 'state.json'), EXEC_LOG: path.join(dir, 'exec.log'), NODE_MAINTENANCE_FILE: path.join(dir, 'maintenance'), DOCKER_CONFIG: '', NODE_REGION: region, NODE_CONTROL_SECRET: '', ORIGIN_SECRET: originSecret, ADMIN_API_SECRET: adminSecret, BASE_DOMAIN: 'cloud.test', SPARTAN_IMAGE: `registry.test/spartan@sha256:${'a'.repeat(64)}`, US_ORIGIN: 'https://us.origin.test/', DE_ORIGIN: 'https://de.origin.test', DATA_ROOT: data, AGENT_PORT: String(agentPort), ...env}});
  let stderr = '';
  agent.stderr.on('data', value => { stderr += value; });
  const origin = `http://127.0.0.1:${agentPort}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(origin); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  const call = async (pathname, payload = {}, secret = adminSecret) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    return fetch(origin + pathname, {method: 'POST', headers: {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(secret, timestamp, 'POST', pathname, body)}, body});
  };
  const json = async (pathname, payload, secret) => { const response = await call(pathname, payload, secret); return {status: response.status, body: await response.json()}; };
  const stop = async () => { agent.kill(); await new Promise(resolve => agent.once('exit', resolve)); await rm(dir, {recursive: true, force: true}); };
  return {dir, data, origin, call, json, stop, stderr: () => stderr};
}

test('admin API authenticates separately and lists tenants with live resource usage', async () => {
  const agent = await startAgent();
  try {
    assert.equal((await fetch(`${agent.origin}/admin/overview`)).status, 401);
    const unsigned = await fetch(`${agent.origin}/admin/fs`, {method: 'POST', body: 'x'.repeat(1024 * 1024)});
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.headers.get('connection'), 'close');
    assert.equal((await agent.call('/admin/overview', {}, originSecret)).status, 401, 'origin secret must not open admin routes');
    const overview = await agent.json('/admin/overview');
    assert.equal(overview.status, 200, agent.stderr());
    assert.equal(overview.body.region, 'us');
    assert.equal(overview.body.node.status, 'ready');
    assert.equal(overview.body.tenants.length, 1);
    const [tenant] = overview.body.tenants;
    assert.equal(tenant.id, id);
    assert.equal(tenant.plan, 'professional');
    assert.equal(tenant.container.running, true);
    assert.equal(tenant.resources.cpuPercent, 12.5);
    assert.equal(tenant.resources.memoryUsedBytes, Math.round(48.5 * 1024 ** 2));
    assert.equal(JSON.stringify(overview.body).includes('topsecret'), false);
    const listed = await agent.json('/control/list', {}, originSecret);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.tenants.map(item => item.id), [id]);
    assert.equal(JSON.stringify(listed.body).includes('topsecret'), false);
    assert.equal((await agent.call('/control/list', {}, adminSecret)).status, 401, 'admin secret must not open control routes');
    const detail = await agent.json('/admin/tenant', {id});
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.container.restartCount, 2);
    assert.ok(detail.body.storageBytes >= 1000);
    assert.equal(detail.body.resources.processes, 17);
    assert.equal((await agent.json('/admin/tenant', {id: 't-' + 'b'.repeat(24)})).status, 404);
    const logs = await agent.json('/admin/logs', {id, tail: 50});
    assert.deepEqual(logs.body.lines.map(line => [line.stream, line.text]), [['stderr', 'err-line'], ['stdout', 'out-line']]);
    const restart = await agent.json('/admin/container', {id, action: 'restart'});
    assert.equal(restart.status, 200);
    assert.equal((await agent.json('/admin/container', {id, action: 'destroy'})).status, 400);
    assert.match(await readFile(path.join(agent.dir, 'exec.log'), 'utf8'), /"power":"restart"/);
    assert.match(agent.stderr(), /"operation":"admin\/container"/);
  } finally { await agent.stop(); }
});

test('admin console runs commands, keeps the working directory and enforces timeouts', async () => {
  const agent = await startAgent();
  const work = path.join(agent.dir, 'work');
  await mkdir(path.join(work, 'sub'), {recursive: true});
  try {
    const first = await agent.json('/admin/exec', {id, command: 'pwd; echo hi; echo oops >&2; exit 3', cwd: work});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.exitCode, 3);
    assert.equal(first.body.stdout, `${work}\nhi\n`);
    assert.equal(first.body.stderr, 'oops\n');
    assert.equal(first.body.cwd, work);
    assert.equal(first.body.user, 'www-data');
    const moved = await agent.json('/admin/exec', {id, command: 'cd sub', cwd: work, user: 'root'});
    assert.equal(moved.body.cwd, path.join(work, 'sub'));
    const stale = await agent.json('/admin/exec', {id, command: 'pwd', cwd: path.join(work, 'deleted')});
    assert.equal(stale.body.stdout, '/\n', 'a vanished working directory falls back to /');
    assert.match(stale.body.stderr, /is not available, using \//);
    assert.equal(stale.body.cwd, '/');
    const slow = await agent.json('/admin/exec', {id, command: 'sleep 5', cwd: work, timeoutSeconds: 1});
    assert.equal(slow.body.timedOut, true);
    assert.equal((await agent.json('/admin/exec', {id, command: 'id', user: 'admin'})).status, 400);
    const calls = (await readFile(path.join(agent.dir, 'exec.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(call => call.program === 'timeout');
    assert.deepEqual(calls.map(call => call.options[1]), ['33:33', '0:0', '33:33', '33:33']);
  } finally { await agent.stop(); }
});

test('admin file manager edits, uploads, downloads, changes permissions and extracts safely', async () => {
  const agent = await startAgent();
  const work = path.join(agent.dir, 'work');
  await mkdir(work);
  const fs = async payload => agent.json('/admin/fs', {id, ...payload});
  const b64 = text => Buffer.from(text).toString('base64');
  try {
    assert.equal((await fs({action: 'mkdir', path: `${work}/site/config`, parents: true})).status, 200);
    const written = await fs({action: 'write', path: `${work}/site/config/app.php`, contentBase64: b64('<?php return 1;\n')});
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.persistent, false);
    const read = await fs({action: 'read', path: `${work}/site/config/app.php`});
    assert.equal(Buffer.from(read.body.contentBase64, 'base64').toString(), '<?php return 1;\n');
    assert.equal(read.body.binary, false);
    assert.equal((await fs({action: 'write', path: `${work}/site/config/app.php`, contentBase64: b64('x'), expectModifiedAt: read.body.modifiedAt - 100})).body.error, 'file_changed');
    assert.equal((await fs({action: 'chmod', path: `${work}/site/config/app.php`, mode: '640'})).status, 200);
    assert.equal((await stat(`${work}/site/config/app.php`)).mode & 0o777, 0o640);
    const overwrite = await fs({action: 'write', path: `${work}/site/config/app.php`, contentBase64: b64('<?php return 2;\n'), expectModifiedAt: read.body.modifiedAt});
    assert.equal(overwrite.status, 200, JSON.stringify(overwrite.body));
    assert.equal((await stat(`${work}/site/config/app.php`)).mode & 0o777, 0o640, 'editing keeps the file mode');
    const listing = await fs({action: 'list', path: `${work}/site`});
    assert.deepEqual(listing.body.entries.map(entry => [entry.name, entry.type]), [['config', 'directory']]);
    assert.match(listing.body.entries[0].permissions, /^d/);
    await writeFile(`${work}/site/.spartan-upload-${'e'.repeat(32)}`, 'abandoned');
    await utimes(`${work}/site/.spartan-upload-${'e'.repeat(32)}`, new Date(Date.now() - 3 * 86400000), new Date(Date.now() - 3 * 86400000));
    const uploadId = 'c'.repeat(32);
    const first = await fs({action: 'upload', path: `${work}/site/big.bin`, uploadId, offset: 0, final: false, contentBase64: b64('hello ')});
    assert.equal(first.body.receivedBytes, 6);
    assert.equal(existsSync(`${work}/site/.spartan-upload-${'e'.repeat(32)}`), false, 'abandoned partial uploads are cleaned up');
    assert.equal((await fs({action: 'upload', path: `${work}/site/big.bin`, uploadId, offset: 3, final: true, contentBase64: b64('x')})).body.error, 'upload_offset_mismatch');
    const last = await fs({action: 'upload', path: `${work}/site/big.bin`, uploadId, offset: 6, final: true, contentBase64: b64('world')});
    assert.equal(last.body.completed, true);
    assert.equal(await readFile(`${work}/site/big.bin`, 'utf8'), 'hello world');
    assert.equal((await fs({action: 'upload', path: `${work}/site/big.bin`, uploadId: 'd'.repeat(32), offset: 0, final: true, contentBase64: b64('no')})).body.error, 'file_exists');
    const file = await agent.call('/admin/fs/download', {id, path: `${work}/site/big.bin`});
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /filename="big.bin"/);
    assert.equal(await file.text(), 'hello world');
    const archive = await agent.call('/admin/fs/download', {id, path: `${work}/site`});
    assert.equal(archive.status, 200);
    assert.match(gunzipSync(Buffer.from(await archive.arrayBuffer())).toString('latin1'), /site\/config\/app\.php/);
    assert.equal((await agent.call('/admin/fs/download', {id, path: `${work}/missing`})).status, 404);
    assert.equal((await fs({action: 'rename', path: `${work}/site/big.bin`, destination: `${work}/site/renamed.bin`})).status, 200);
    assert.equal((await fs({action: 'copy', path: `${work}/site/config`, destination: `${work}/site/config-copy`})).status, 200);
    assert.ok(existsSync(`${work}/site/config-copy/app.php`));
    execFileSync('python3', ['-c', `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(work + '/m.zip')},'w')\nz.writestr('module/a.txt','A')\nz.writestr('../escape.txt','E')\nz.writestr('/abs.txt','B')\nz.close()`]);
    const extracted = await fs({action: 'extract', path: `${work}/m.zip`, destination: `${work}/site`});
    assert.equal(extracted.status, 200, JSON.stringify(extracted.body));
    assert.equal(extracted.body.extracted, 1);
    assert.equal(extracted.body.skipped, 2);
    assert.equal(await readFile(`${work}/site/module/a.txt`, 'utf8'), 'A');
    assert.equal(existsSync(`${work}/escape.txt`), false);
    assert.equal((await fs({action: 'delete', path: `${work}/site`})).body.error, 'directory_not_empty');
    assert.equal((await fs({action: 'delete', path: '/etc'})).status, 403);
    assert.equal((await fs({action: 'delete', path: '/var/www/html'})).body.error, 'protected_path');
    assert.equal((await fs({action: 'delete', path: `${work}/site`, recursive: true})).status, 200);
    assert.equal(existsSync(`${work}/site`), false);
    assert.equal((await fs({action: 'read', path: `${work}/nothing`})).status, 404);
    assert.equal((await fs({action: 'list', path: 'relative'})).status, 400);
  } finally { await agent.stop(); }
});

test('admin routes stay disabled when the admin secret is missing or reuses the origin secret', async () => {
  const agent = await startAgent({env: {ADMIN_API_SECRET: originSecret}});
  try {
    assert.equal((await agent.call('/admin/overview', {}, originSecret)).status, 404);
    assert.match(agent.stderr(), /admin_api_disabled/);
    assert.equal((await agent.json('/control/list', {}, originSecret)).status, 200, 'tenant traffic and control routes keep working');
  } finally { await agent.stop(); }
});

test('secondary node forwards to an origin configured with a trailing slash', async t => {
  let certificate;
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], {stdio: 'ignore'});
    certificate = {key: await readFile(path.join(dir, 'key.pem')), cert: await readFile(path.join(dir, 'cert.pem'))};
  } catch { t.skip('openssl unavailable'); await rm(dir, {recursive: true, force: true}); return; }
  const seen = [];
  const primary = https.createServer(certificate, (req, res) => { seen.push(req.url); res.end('forwarded'); });
  await new Promise(resolve => primary.listen(0, '127.0.0.1', resolve));
  const agent = await startAgent({region: 'de', env: {US_ORIGIN: `https://localhost:${primary.address().port}/`, NODE_TLS_REJECT_UNAUTHORIZED: '0'}});
  try {
    const response = await fetch(`${agent.origin}/tenant/${id}/dashboard?a=1`, {headers: {'x-spartan-origin': originSecret, 'x-spartan-client-ip': '203.0.113.9', 'x-spartan-host': `${id}.cloud.test`}});
    assert.equal(await response.text(), 'forwarded', agent.stderr());
    assert.deepEqual(seen, [`/tenant/${id}/dashboard?a=1`]);
  } finally { await agent.stop(); primary.close(); await rm(dir, {recursive: true, force: true}); }
});
