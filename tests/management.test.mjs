import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {createManagement, processInput, validateEnvironment, validImage} from '../node/management.mjs';
import {fileProgram, validFileRequest} from '../node/tenant-files.mjs';

const id = 't-' + 'a'.repeat(24), fingerprint = 'b'.repeat(64);

test('file manager rejects traversal, node paths, invalid data and protected folder changes', () => {
  for (const value of ['/Modules/../.env', '/Themes//x', '/storage/x', '/etc/passwd', '/Modules/a\\b', '/Modules/a\0b']) {
    assert.throws(() => validFileRequest({action: 'download', path: value}), /invalid_file_request/);
  }
  assert.throws(() => validFileRequest({action: 'delete', path: '/Modules'}), /protected_directory/);
  assert.throws(() => validFileRequest({action: 'rename', path: '/Modules/a', destination: '/Themes/a'}), /invalid_destination/);
  assert.throws(() => validFileRequest({action: 'upload', path: '/Modules/a', contentBase64: '%%%'}), /invalid_file_content/);
  assert.equal(validImage('ghcr.io/dezer-x/spartan@sha256:' + 'a'.repeat(64)), true);
  assert.equal(validImage('ghcr.io/dezer-x/spartan:latest'), false);
  validFileRequest({action: 'upload', path: '/Modules/large', contentBase64: Buffer.alloc(4 * 1024 * 1024).toString('base64')});
});

test('environment editing preserves application, database, licensing and routing identity', () => {
  const before = 'APP_KEY=base64:unchanged\nAPP_URL=https://instance-1234.dezerx.cloud\nDB_PASSWORD=secret\nLICENSE_KEY=SPARTANDEV_test\nCUSTOM=value\n';
  assert.match(validateEnvironment(before, before.replace('CUSTOM=value', 'CUSTOM="updated value"')), /CUSTOM=updated value/);
  for (const key of ['APP_KEY', 'APP_URL', 'DB_PASSWORD', 'LICENSE_KEY']) {
    assert.throws(() => validateEnvironment(before, before.replace(new RegExp('^' + key + '=.*$', 'm'), key + '=changed')), /protected_environment_key/);
    assert.throws(() => validateEnvironment(before, before.replace(new RegExp('^' + key + '=.*\n', 'm'), '')), /protected_environment_key/);
  }
  assert.throws(() => validateEnvironment(before, before + 'ORIGIN_SECRET=not-allowed\n'), /protected_environment_key/);
  assert.throws(() => validateEnvironment(before, before + 'CUSTOM=duplicate\n'), /invalid_environment/);
});

test('real file helper persists uploads and performs bounded downloads, directories, renames and deletes without following links', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-files-'));
  const app = path.join(dir, 'app');
  try {
    await mkdir(path.join(app, 'Modules'), {recursive: true});
    await mkdir(path.join(app, 'Themes'), {recursive: true});
    await mkdir(path.join(app, 'storage/container'), {recursive: true});
    await writeFile(path.join(app, 'Modules/built-in.txt'), 'built-in');
    const program = fileProgram.replaceAll('/var/www/html', app);
    const operation = async input => {
      validFileRequest(input);
      return JSON.parse(await processInput('python3', ['-c', program], JSON.stringify(input)));
    };
    const listed = await operation({action: 'list', path: '/Modules'});
    assert.equal(listed.persistent, true);
    assert.equal((await lstat(path.join(app, 'Modules'))).isSymbolicLink(), true);
    assert.equal(listed.entries[0].name, 'built-in.txt');
    assert.equal((await operation({action: 'mkdir', path: '/Modules/Custom'})).created, true);
    assert.equal((await operation({action: 'upload', path: '/Modules/Custom/code.php', contentBase64: Buffer.from('<?php echo 1;').toString('base64')})).writtenBytes, 13);
    const downloaded = await operation({action: 'download', path: '/Modules/Custom/code.php'});
    assert.equal(Buffer.from(downloaded.contentBase64, 'base64').toString(), '<?php echo 1;');
    assert.equal(await readFile(path.join(app, 'storage/container/Modules/Custom/code.php'), 'utf8'), '<?php echo 1;');
    assert.equal((await operation({action: 'rename', path: '/Modules/Custom/code.php', destination: '/Modules/Custom/renamed.php'})).renamed, true);
    assert.equal((await operation({action: 'delete', path: '/Modules/Custom'})).error, 'unsafe_or_unavailable_path');
    assert.equal((await operation({action: 'delete', path: '/Modules/Custom/renamed.php'})).deleted, true);
    assert.equal((await operation({action: 'delete', path: '/Modules/Custom'})).deleted, true);
    const outside = path.join(dir, 'outside.txt');
    await writeFile(outside, 'outside-secret');
    await symlink(outside, path.join(app, 'Modules/link.txt'));
    assert.equal((await operation({action: 'download', path: '/Modules/link.txt'})).error, 'unsafe_link');
    assert.equal((await operation({action: 'upload', path: '/Modules/link.txt', contentBase64: 'eA=='})).error, 'unsafe_link');
    await symlink(dir, path.join(app, 'Modules/outside'));
    assert.ok((await operation({action: 'download', path: '/Modules/outside/outside.txt'})).error);
    await link(outside, path.join(app, 'Modules/hard.txt'));
    assert.equal((await operation({action: 'download', path: '/Modules/hard.txt'})).error, 'unsafe_link');
    assert.equal(await readFile(outside, 'utf8'), 'outside-secret');
    await writeFile(path.join(app, 'Themes/large'), Buffer.alloc(4194305));
    assert.equal((await operation({action: 'download', path: '/Themes/large'})).error, 'file_too_large');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('management returns only public instance data, checks ownership and exports only the primary tenant database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spartan-management-'));
  let record = {id, fingerprint, primary: 'us', role: 'primary', status: 'ready', url: 'https://instance-1234.dezerx.cloud', image: 'image', port: 1234, appKey: 'private-app-key', dbPassword: 'private-password', licenseKey: 'private-license'};
  const calls = [];
  const management = createManagement({root, cfg: {NODE_REGION: 'us'}, load: async () => record, save: async next => {record = next;}, mysql: {ready: async () => true}, applicationHealth: async () => true,
    docker: async args => {
      calls.push(args);
      if (args[0] === 'inspect') return JSON.stringify([{Config: {Image: 'image', Labels: {'spartan.tenant': id, 'spartan.managed': 'true', 'spartan.fingerprint': fingerprint}}, State: {Running: true}}]);
      if (args[0] === 'stats') return JSON.stringify({CPUPerc: '12.5%', MemUsage: '40MiB / 512MiB', MemPerc: '7.8%', PIDs: '8'});
      return 'Docker version';
    }, inputProcess: async (command, args) => {assert.equal(command, 'docker'); assert.ok(args.at(-1).includes('versions.json')); return '{"version":"1.2.3"}';},
    launch: (command, args, options) => {
      assert.equal(command, 'prlimit');
      assert.equal(args.at(-1), 'sp_' + 'a'.repeat(24));
      assert.ok(args.includes('--single-transaction'));
      assert.equal(args.some(value => value.includes('private-password')), false);
      return spawn(process.execPath, ['-e', 'process.stdout.write("CREATE TABLE example (id INT);\\n")'], options);
    }});
  let server, pendingExport;
  try {
    const info = await management.information({id, fingerprint}, true);
    assert.equal(info.url, record.url);
    assert.equal(info.resources.cpuPercent, 12.5);
    assert.equal(info.applicationHealthy, true);
    for (const secret of ['private-app-key', 'private-password', 'private-license', fingerprint]) assert.equal(JSON.stringify(info).includes(secret), false);
    assert.equal(calls.find(args => args[0] === 'stats').at(-1), 'spartan-' + id);
    assert.equal((await management.nodeHealth()).resources.memory.totalBytes > 0, true);
    assert.equal((await management.version({id, fingerprint})).versions.version, '1.2.3');
    await assert.rejects(management.information({id, fingerprint: 'c'.repeat(64)}), /tenant_conflict/);
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'app.env'), 'APP_KEY=base64:unchanged\nCUSTOM=value\n');
    await management.files({id, fingerprint, path: '/.env', action: 'upload', contentBase64: Buffer.from('APP_KEY=base64:unchanged\nCUSTOM=new\n').toString('base64')});
    assert.match(await readFile(path.join(root, id, 'app.env'), 'utf8'), /CUSTOM=new/);
    assert.equal(record.envHash.length, 64);
    server = http.createServer((req, res) => { pendingExport = management.sqlDownload({id, fingerprint}, res).catch(() => {res.writeHead(500);res.end();}); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.headers.get('content-type'), 'application/sql');
    assert.equal(await response.text(), 'CREATE TABLE example (id INT);\n');
    await pendingExport;
    record = {...record, role: 'secondary'};
    await assert.rejects(management.sqlDownload({id, fingerprint}, {}), /primary_node_required/);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true}); }
});
