import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {proxyCacheControl, NO_STORE} from '../node/cache-policy.mjs';
import {normalizeCpuLimit, tenantCpus, cpuSummary, requestedCpuLimit, DEFAULT_TENANT_CPUS} from '../node/resources.mjs';
import {migrateCacheEnvironment, switchCacheEnvironment, cacheEnvironment, imageSupportsRedis, REDIS_CACHE_LABEL} from '../node/tenant-env.mjs';

test('the node keeps the application cache policy but never shares cookies or unlabelled responses', () => {
  const immutable = 'public, max-age=31536000, immutable';
  assert.equal(proxyCacheControl('GET', {'cache-control': immutable}), immutable);
  assert.equal(proxyCacheControl('HEAD', {'cache-control': immutable}), immutable);
  assert.equal(proxyCacheControl('GET', {'cache-control': 'no-cache, private'}), 'no-cache, private');
  assert.equal(proxyCacheControl('GET', {}), NO_STORE, 'no policy keeps the safe default');
  assert.equal(proxyCacheControl('GET', {'cache-control': '  '}), NO_STORE);
  assert.equal(proxyCacheControl('GET', {'cache-control': immutable, 'set-cookie': ['a=b']}), NO_STORE, 'a cookie is never stored by a shared cache');
  assert.equal(proxyCacheControl('POST', {'cache-control': immutable}), NO_STORE);
  assert.equal(proxyCacheControl('GET', {'cache-control': 'public\r\nx: y'}), NO_STORE);
});

test('CPU limits are validated, default to 2.5 and can be overridden per tenant', () => {
  assert.equal(DEFAULT_TENANT_CPUS, '2.5');
  for (const [input, expected] of [['2.5', '2.5'], [2.5, '2.5'], ['3', '3'], ['0.25', '0.25'], ['1.50', '1.5'], ['64', '64'], [' 2 ', '2']]) assert.equal(normalizeCpuLimit(input), expected);
  for (const input of ['0', '0.05', '65', '-1', '1e2', 'two', '2.555', '', null, undefined, true, {}, NaN, Infinity]) assert.equal(normalizeCpuLimit(input), null, String(input));
  assert.equal(tenantCpus({}, {}), '2.5', 'no node setting: the new default');
  assert.equal(tenantCpus({TENANT_CPUS: '1'}, {}), '1', 'an explicit node setting is respected');
  assert.equal(tenantCpus({TENANT_CPUS: 'bad'}, null), '2.5');
  assert.equal(tenantCpus({TENANT_CPUS: '1'}, {cpuLimit: '3'}), '3', 'a tenant override wins');
  assert.deepEqual(cpuSummary({TENANT_CPUS: '2'}, {cpuLimit: '4'}), {cpuLimit: '4', cpuLimitSource: 'tenant', nodeCpuDefault: '2'});
  assert.deepEqual(cpuSummary({}, {}), {cpuLimit: '2.5', cpuLimitSource: 'node', nodeCpuDefault: '2.5'});
  assert.equal(requestedCpuLimit(null), null);
  assert.equal(requestedCpuLimit('default'), null);
  assert.equal(requestedCpuLimit('3.5'), '3.5');
  assert.throws(() => requestedCpuLimit('99'), error => error.message === 'invalid_cpu_limit' && error.apiStatus === 422);
  assert.throws(() => requestedCpuLimit(undefined), /invalid_cpu_limit/);
});

test('a legacy tenant environment moves to Redis without touching database sessions', () => {
  const legacy = 'APP_KEY=x\nSESSION_DRIVER=file\nCACHE_STORE=file\nCACHE_DRIVER="file"\nQUEUE_CONNECTION=database\n';
  const result = migrateCacheEnvironment(legacy);
  assert.equal(result.changed, true);
  assert.equal(result.text, 'APP_KEY=x\nSESSION_DRIVER=redis\nCACHE_STORE=redis\nCACHE_DRIVER=redis\nQUEUE_CONNECTION=database\n');
  const central = 'SESSION_DRIVER=database\nCACHE_STORE=file\n';
  assert.equal(migrateCacheEnvironment(central).text, 'SESSION_DRIVER=database\nCACHE_STORE=redis\n', 'shared database sessions stay');
  const current = 'SESSION_DRIVER=redis\nCACHE_STORE=redis\n';
  assert.deepEqual(migrateCacheEnvironment(current), {text: current, changed: false});
  assert.equal(migrateCacheEnvironment('CACHE_STORE=filesystem\nMY_CACHE_STORE=file\n').changed, false, 'only exact keys and values change');
});

test('the Redis cache is used only with images that start Redis before migrations', async () => {
  assert.deepEqual(cacheEnvironment({redis: true, databaseSessions: false}), {SESSION_DRIVER: 'redis', CACHE_STORE: 'redis', CACHE_DRIVER: 'redis'});
  assert.deepEqual(cacheEnvironment({redis: false, databaseSessions: false}), {SESSION_DRIVER: 'file', CACHE_STORE: 'file', CACHE_DRIVER: 'file'});
  assert.deepEqual(cacheEnvironment({redis: true, databaseSessions: true}), {SESSION_DRIVER: 'database', CACHE_STORE: 'redis', CACHE_DRIVER: 'redis'});
  const back = switchCacheEnvironment('SESSION_DRIVER=redis\nCACHE_STORE="redis"\nCACHE_DRIVER=redis\nQUEUE_CONNECTION=database\n', false);
  assert.deepEqual(back, {text: 'SESSION_DRIVER=file\nCACHE_STORE=file\nCACHE_DRIVER=file\nQUEUE_CONNECTION=database\n', changed: true}, 'an old image is moved back to files');
  assert.equal(switchCacheEnvironment('SESSION_DRIVER=database\nCACHE_STORE=redis\n', false).text, 'SESSION_DRIVER=database\nCACHE_STORE=file\n');
  const calls = [];
  const docker = labels => async args => { calls.push(args); if (args[0] === 'pull') { labels.pulled = true; return ''; } if (labels.missing && !labels.pulled) throw new Error('No such image'); return labels.value; };
  assert.equal(await imageSupportsRedis(docker({value: '1\n'}), 'img'), true);
  assert.equal(await imageSupportsRedis(docker({value: ''}), 'img'), false, 'no label: an older image');
  assert.equal(await imageSupportsRedis(docker({value: '<no value>'}), 'img'), false);
  assert.equal(await imageSupportsRedis(docker({value: '1', missing: true}), 'img'), true, 'an image not yet on the node is pulled first');
  assert.ok(calls.some(args => args[0] === 'pull'));
  assert.equal(await imageSupportsRedis(async () => { throw new Error('docker down'); }, 'img'), false, 'any failure means the file cache');
  const dockerfile = await readFile('runtime/Dockerfile', 'utf8');
  assert.ok(dockerfile.includes(`LABEL ${REDIS_CACHE_LABEL}="1"`), 'the image built from this repository declares Redis support');
});

test('runtime serves hashed bundles as immutable, compresses, and sizes the Octane pool', async () => {
  const nginx = await readFile('runtime/nginx.conf', 'utf8');
  const assets = nginx.match(/location \/build\/assets\/ \{([\s\S]*?)\n    \}/);
  assert.ok(assets, 'a dedicated location for Vite bundles');
  assert.match(assets[1], /include \/etc\/nginx\/spartan-origin-auth\.conf;/, 'bundles still require the ingress key');
  assert.match(assets[1], /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(nginx, /^\s*gzip on;/m);
  assert.match(nginx, /gzip_types[^;]*application\/javascript[^;]*;/);
  const supervisor = await readFile('runtime/supervisord.conf', 'utf8');
  assert.match(supervisor, /--workers=%\(ENV_OCTANE_WORKERS\)s --max-requests=%\(ENV_OCTANE_MAX_REQUESTS\)s/);
  const entrypoint = await readFile('runtime/entrypoint.sh', 'utf8');
  assert.match(entrypoint, /OCTANE_WORKERS=4/);
  assert.match(entrypoint, /OCTANE_MAX_REQUESTS=10000/);
  assert.ok(entrypoint.indexOf('redis-server') < entrypoint.indexOf('dezerx-entrypoint cloud-init'), 'Redis is up before migrations touch the cache');
  assert.ok(entrypoint.indexOf('shutdown') < entrypoint.indexOf('exec supervisord'), 'the early Redis hands over to supervisord');
  const redis = await readFile('runtime/redis.conf', 'utf8');
  assert.match(redis, /^maxmemory-policy allkeys-lru$/m);
  assert.doesNotMatch(redis, /^maxmemory-policy noeviction/m);
});
