import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile, writeFile, rename, statfs, mkdtemp, rm, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {databaseName} from './mysql.mjs';
import {fileProgram, validFileRequest} from './tenant-files.mjs';

export function apiError(code, status = 400) {
  return Object.assign(new Error(code), {apiStatus: status});
}
export const validImage = value => typeof value === 'string' && value.length <= 255 && /^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(value);

export function processInput(command, args, input, {timeout = 30000, maxBytes = 8 * 1024 * 1024, launch = spawn} = {}) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, {stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = [];
    let bytes = 0, failure;
    const timer = setTimeout(() => { failure = apiError('command_timeout', 504); child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = apiError('file_too_large', 413); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(apiError('container_operation_failed', 409));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

function parseEnv(text, docker = false) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || Object.hasOwn(result, match[1])) throw apiError('invalid_environment');
    let value = match[2];
    if (!docker && value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\["\\])*"$/.test(value)) throw apiError('invalid_environment');
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (!docker && /[\s'"\\]/.test(value)) throw apiError('invalid_environment');
    if (/[\x00-\x1f\x7f]/.test(value)) throw apiError('invalid_environment');
    result[match[1]] = value;
  }
  return result;
}
const protectedKey = key => /^(APP_(KEY|URL|ENV|DEBUG)|ASSET_URL|LICENSE_KEY|PRODUCT_ID|DB_.*|CLOUD_ROLE|TENANT_ID|OCTANE_.*|SESSION_.*|NODE_.*|ORIGIN_SECRET)$/.test(key);
export function validateEnvironment(before, after) {
  const previous = parseEnv(before, true), next = parseEnv(after);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (protectedKey(key) && previous[key] !== next[key]) throw apiError('protected_environment_key');
  }
  if (Object.keys(next).length > 250) throw apiError('invalid_environment');
  return Object.entries(next).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

export function createManagement({cfg, root, load, save, docker, mysql, applicationHealth, inputProcess = processInput, launch = spawn}) {
  let previous = os.cpus().map(cpu => cpu.times);
  let cpuPercent = null;
  const sampler = setInterval(() => {
    const current = os.cpus().map(cpu => cpu.times);
    let total = 0, idle = 0;
    current.forEach((cpu, i) => {
      if (!previous[i]) return;
      for (const [key, value] of Object.entries(cpu)) total += value - previous[i][key];
      idle += cpu.idle - previous[i].idle;
    });
    cpuPercent = total > 0 ? Math.round((1 - idle / total) * 10000) / 100 : null;
    previous = current;
  }, 1000);
  sampler.unref();
  async function tenant(input, {running = false, primary = false} = {}) {
    const record = await load(input.id);
    if (!record) throw apiError('not_provisioned', 404);
    if (record.fingerprint !== input.fingerprint) throw apiError('tenant_conflict', 409);
    if (primary && record.role !== 'primary') throw apiError('primary_node_required', 409);
    if (record.status === 'terminated') throw apiError('service_terminated', 410);
    let inspect;
    try { inspect = JSON.parse(await docker(['inspect', `spartan-${record.id}`]))[0]; }
    catch (error) {
      if (!/No such (object|container)/i.test(String(error.stderr || error.message))) throw error;
    }
    if (inspect) {
      const labels = inspect.Config?.Labels || {};
      if (labels['spartan.tenant'] !== record.id || labels['spartan.fingerprint'] !== record.fingerprint || labels['spartan.managed'] !== 'true') throw apiError('container_conflict', 409);
    }
    if (running && !inspect?.State?.Running) throw apiError('container_not_running', 409);
    return {record, inspect};
  }
  async function nodeHealth() {
    let dockerReady = false;
    try { await docker(['info', '--format', '{{.ServerVersion}}']); dockerReady = true; } catch {}
    const databaseReady = await mysql.ready();
    const disk = await statfs(root, {bigint: true});
    return {region: cfg.NODE_REGION, status: dockerReady && databaseReady ? 'ready' : 'degraded', dockerReady, databaseReady,
      resources: {cpu: {cores: os.cpus().length, usagePercent: cpuPercent, loadAverage: os.loadavg()}, memory: {totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem(), freeBytes: os.freemem()}, disk: {totalBytes: Number(disk.blocks * disk.bsize), availableBytes: Number(disk.bavail * disk.bsize), usedBytes: Number((disk.blocks - disk.bfree) * disk.bsize)}, uptimeSeconds: os.uptime()}, sampledAt: new Date().toISOString()};
  }
  async function information(input, health = false) {
    const {record, inspect} = await tenant(input);
    const result = {id: record.id, region: cfg.NODE_REGION, primary: record.primary, role: record.role, status: record.status, url: record.url, activeUrl: record.containerUrl || record.url, lifecycleVersion: record.lifecycleVersion || 0, image: inspect?.Config?.Image || record.image, running: inspect?.State?.Running === true, containerHealth: inspect?.State?.Health?.Status || 'not_configured'};
    if (health && inspect?.State?.Running) {
      const raw = await docker(['stats', '--no-stream', '--format', '{{json .}}', `spartan-${record.id}`]);
      const stats = JSON.parse(raw);
      result.resources = {cpuPercent: Number.parseFloat(stats.CPUPerc) || 0, memoryUsage: stats.MemUsage, memoryPercent: Number.parseFloat(stats.MemPerc) || 0, networkIO: stats.NetIO, blockIO: stats.BlockIO, processes: Number(stats.PIDs) || 0};
      result.applicationHealthy = await applicationHealth(record.port, record.containerUrl || record.url).catch(() => false);
      result.sampledAt = new Date().toISOString();
    } else if (health) result.resources = null;
    return result;
  }
  async function version(input) {
    const {record, inspect} = await tenant(input, {running: true});
    const code = "import os,json,stat,sys; p='/var/www/html/versions.json'; f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW); s=os.fstat(f); assert stat.S_ISREG(s.st_mode) and s.st_size<=65536; data=os.read(f,65537); json.loads(data); sys.stdout.write(data.decode())";
    const versions = JSON.parse(await inputProcess('docker', ['exec', '--user', '33:33', `spartan-${record.id}`, 'python3', '-c', code], '', {maxBytes: 65536}));
    return {id: record.id, image: inspect.Config.Image || record.image, versions};
  }
  async function files(input) {
    validFileRequest(input);
    const {record} = await tenant(input, {running: input.path !== '/.env'});
    if (input.path === '/.env') {
      const filename = path.join(root, record.id, 'app.env');
      const handle = await open(filename, 'r');
      let existing;
      try {
        if ((await handle.stat()).size > 65536) throw apiError('file_too_large', 413);
        existing = await handle.readFile('utf8');
      } finally { await handle.close(); }
      if (input.action === 'download') {
        const editable = Object.entries(parseEnv(existing, true)).map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n') + '\n';
        return {id: record.id, path: input.path, contentBase64: Buffer.from(editable).toString('base64'), needsApply: record.envHash !== record.containerEnvHash};
      }
      if (input.action !== 'upload') throw apiError('environment_action_not_allowed');
      const content = Buffer.from(input.contentBase64, 'base64');
      if (content.length > 65536) throw apiError('file_too_large', 413);
      const checked = validateEnvironment(existing, content.toString('utf8'));
      const temp = `${filename}.upload`;
      await writeFile(temp, checked, {mode: 0o600});
      await rename(temp, filename);
      await save({...record, envHash: createHash('sha256').update(checked).digest('hex')});
      return {id: record.id, path: input.path, needsApply: true};
    }
    await docker(['exec', '--user', '0:0', `spartan-${record.id}`, 'chown', '--no-dereference', '33:33', '/var/www/html']);
    const output = await inputProcess('docker', ['exec', '-i', '--user', '33:33', `spartan-${record.id}`, 'python3', '-c', fileProgram], JSON.stringify({action: input.action, path: input.path, destination: input.destination, contentBase64: input.contentBase64}));
    const result = JSON.parse(output);
    if (result.error) throw apiError(result.error, result.status || 400);
    return {id: record.id, ...result, needsReload: ['upload', 'delete', 'rename', 'mkdir'].includes(input.action)};
  }
  async function sqlExport(input, res) {
    const {record} = await tenant(input, {primary: true});
    const directory = await mkdtemp(path.join(os.tmpdir(), 'spartan-sql-'));
    const filename = path.join(directory, 'database.sql');
    const handle = await open(filename, 'wx', 0o600);
    try {
      const disk = await statfs(directory, {bigint: true});
      const limit = Math.min(1024 * 1024 * 1024, Math.floor(Number(disk.bavail * disk.bsize) / 2));
      if (limit < 1024 * 1024) throw apiError('export_disk_capacity', 503);
      await new Promise((resolve, reject) => {
        const child = launch('prlimit', [`--fsize=${limit}:${limit}`, '--', 'mariadb-dump', '--protocol=socket', `--socket=${cfg.MYSQL_SOCKET || '/run/mysqld/mysqld.sock'}`, '-uroot', '--single-transaction', '--quick', '--skip-lock-tables', '--hex-blob', '--', databaseName(record.id)], {stdio: ['ignore', handle.fd, 'pipe']});
        child.stderr.resume();
        let failure;
        const timer = setTimeout(() => {failure = apiError('export_timeout', 504); child.kill('SIGKILL');}, 300000);
        const abort = () => {failure = apiError('export_aborted', 499); child.kill('SIGKILL');};
        res.once('close', abort);
        child.once('error', error => { clearTimeout(timer); res.off('close', abort); reject(error); });
        child.once('close', code => {clearTimeout(timer); res.off('close', abort); code === 0 && !failure ? resolve() : reject(failure || apiError('export_failed', 503));});
      });
      const size = (await handle.stat()).size;
      await handle.close();
      res.writeHead(200, {'content-type': 'application/sql', 'content-disposition': `attachment; filename="${record.id}.sql"`, 'content-length': size, 'cache-control': 'private, no-store'});
      const source = await open(filename, 'r');
      try {
        await new Promise((resolve, reject) => {
          const stream = source.createReadStream({autoClose: false});
          stream.once('error', reject);
          res.once('finish', resolve);
          res.once('close', () => {stream.destroy(); resolve();});
          stream.pipe(res);
        });
      } finally { await source.close(); }
    } finally { await handle.close().catch(() => {}); await rm(directory, {recursive: true, force: true}); }
  }
  let exporting = false;
  async function sqlDownload(input, res) {
    if (exporting) throw apiError('export_in_progress', 429);
    exporting = true;
    try { return await sqlExport(input, res); }
    finally { exporting = false; }
  }
  return {nodeHealth, information, version, files, sqlDownload};
}
