// In-browser stand-in for the dashboard server, used only by the static preview built
// with build-preview.mjs. Nothing here talks to a real node.
(() => {
  const GB = 1024 ** 3, MB = 1024 ** 2;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const hex = n => Array.from({length: n}, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const seeded = (seed => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; })(42);
  const id = () => 't-' + Array.from({length: 24}, () => '0123456789abcdef'[Math.floor(seeded() * 16)]).join('');
  const image = 'ghcr.io/dezer-x/dezerx-spartan@sha256:b681836d7bb0bae11e26891d3431f50ce5f35daf9a5efbf0bb45ffa10924ea9a';
  const plans = ['starter', 'cloudplus', 'professional', 'ultimate'];
  const make = (host, region, cpu, mem, extra = {}) => {
    const tid = id();
    return {id: tid, region, primary: region, role: 'primary', status: 'ready', url: `https://${host || `${tid}.load.dezerx.cloud`}`, activeUrl: `https://${host || `${tid}.load.dezerx.cloud`}`, image, port: 32000 + Math.floor(seeded() * 900), lifecycleVersion: Math.floor(seeded() * 4), fingerprint: hex(64), plan: plans[Math.floor(seeded() * 4)], adminInitialized: true, environmentPending: false, baseCpu: cpu, baseMem: mem, container: {state: 'running', running: true, statusText: 'Up 3 days'}, ...extra};
  };
  const tenants = [
    make('billing.northwind-hosting.test', 'us', 42, 812), make('portal.brightlane.test', 'us', 18, 540), make('clients.vortexhost.test', 'us', 63, 1180),
    make(null, 'us', 3, 210), make('my.cloudnest.test', 'us', 9, 388), make('panel.redwoodvps.test', 'us', 0, 0, {container: {state: 'exited', running: false, statusText: 'Exited (0) 2 hours ago'}}),
    make('billing.hostkraft.test', 'de', 27, 702), make('kunden.alpenserver.test', 'de', 12, 455), make(null, 'de', 2, 190),
    make('app.serverforge.test', 'de', 88, 1640), make('secure.lumenhost.test', 'de', 6, 320, {status: 'suspended', container: {state: 'exited', running: false}})
  ];
  const resources = t => t.container.running ? {cpuPercent: Math.max(0, t.baseCpu + rand(-4, 4)), memoryUsedBytes: (t.baseMem + rand(-12, 12)) * MB, memoryLimitBytes: 2 * GB, memoryPercent: t.baseMem / 20.48, networkRxBytes: 1.2e9, networkTxBytes: 3.4e9, blockReadBytes: 2.1e8, blockWriteBytes: 9.6e8, processes: 14 + Math.floor(rand(0, 9))} : null;
  const strip = ({baseCpu, baseMem, region, ...rest}) => rest;
  const host = {us: 'node-us.dezerx.cloud', de: 'node-de.dezerx.cloud'};
  const node = region => {
    const list = tenants.filter(t => t.region === region);
    const used = list.reduce((s, t) => s + (t.container.running ? t.baseMem * MB : 0), 0) + 3.1 * GB;
    return {region, label: region === 'us' ? 'United States' : 'Germany', host: host[region], ok: true, latencyMs: region === 'us' ? Math.round(rand(118, 140)) : Math.round(rand(3, 6)),
      node: {region, status: 'ready', dockerReady: true, dockerVersion: '29.9.0', databaseReady: true, sampledAt: new Date().toISOString(), resources: {network: {rxBytesPerSecond: Math.round(rand(region === 'us' ? 1.1e6 : 4e5, region === 'us' ? 2.4e6 : 9e5)), txBytesPerSecond: Math.round(rand(region === 'us' ? 3e6 : 8e5, region === 'us' ? 6e6 : 1.6e6)), linkMbps: region === 'us' ? 1000 : 0}, cpu: {cores: 8, usagePercent: list.reduce((s, t) => s + (t.container.running ? t.baseCpu : 0), 0) / 8 + rand(4, 9), loadAverage: [rand(1, 3), rand(1, 2.5), rand(.8, 2)]}, memory: {totalBytes: 32 * GB, usedBytes: used, freeBytes: 32 * GB - used}, disk: {totalBytes: 320 * GB, usedBytes: (region === 'us' ? 141 : 97) * GB, availableBytes: (region === 'us' ? 179 : 223) * GB}, uptimeSeconds: region === 'us' ? 1003200 : 412800}},
      tenants: list.map(t => ({...strip(t), resources: resources(t)}))};
  };
  const activity = [
    {time: new Date(Date.now() - 3.6e6).toISOString(), event: 'login', user: 'admin', ip: '198.51.100.24'},
    {time: new Date(Date.now() - 3.4e6).toISOString(), event: 'action', user: 'admin', region: 'us', id: tenants[2].id, action: 'exec', runAs: 'www-data', command: 'php artisan queue:failed'},
    {time: new Date(Date.now() - 2.9e6).toISOString(), event: 'action', user: 'admin', region: 'de', id: tenants[9].id, action: 'fs_write', path: '/var/www/html/storage/app/settings.json', runAs: 'www-data'}
  ];
  const note = (region, tid, action, extra = {}) => activity.unshift({time: new Date().toISOString(), event: 'action', user: 'admin', region, id: tid, action, ...extra});

  // A small in-memory filesystem shaped like a Spartan container.
  const now = Date.now() / 1000;
  const files = new Map();
  const add = (path, type, content = '', mode = type === 'directory' ? '0755' : '0644', owner = 'www-data') => files.set(path, {type, content, mode, owner, group: owner, modifiedAt: now - rand(600, 9e5)});
  ['/', '/var', '/var/www', '/var/www/html', '/var/www/html/app', '/var/www/html/app/Http', '/var/www/html/app/Models', '/var/www/html/bootstrap', '/var/www/html/config', '/var/www/html/database', '/var/www/html/Modules', '/var/www/html/Modules/Billing', '/var/www/html/Themes', '/var/www/html/Themes/Default', '/var/www/html/public', '/var/www/html/resources', '/var/www/html/routes', '/var/www/html/storage', '/var/www/html/storage/app', '/var/www/html/storage/logs', '/var/www/html/storage/framework', '/var/www/html/vendor', '/etc', '/tmp'].forEach(p => add(p, 'directory', '', p === '/tmp' ? '1777' : '0755', ['/', '/var', '/etc', '/tmp', '/var/www'].includes(p) ? 'root' : 'www-data'));
  add('/var/www/html/artisan', 'file', '#!/usr/bin/env php\n<?php\n\ndefine(\'LARAVEL_START\', microtime(true));\n\nrequire __DIR__.\'/vendor/autoload.php\';\n', '0755');
  add('/var/www/html/composer.json', 'file', '{\n    "name": "dezerx/spartan",\n    "type": "project",\n    "require": {\n        "php": "^8.4",\n        "laravel/framework": "^12.0",\n        "laravel/octane": "^2.6"\n    }\n}\n');
  add('/var/www/html/versions.json', 'file', '{\n    "spartan": "4.12.0",\n    "laravel": "12.31.1",\n    "php": "8.4.13"\n}\n');
  add('/var/www/html/routes/web.php', 'file', "<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/', fn () => view('welcome'));\n");
  add('/var/www/html/config/app.php', 'file', "<?php\n\nreturn [\n    'name' => env('APP_NAME', 'Spartan'),\n    'env' => env('APP_ENV', 'production'),\n    'debug' => (bool) env('APP_DEBUG', false),\n    'url' => env('APP_URL', 'http://localhost'),\n    'timezone' => 'UTC',\n];\n");
  add('/var/www/html/storage/app/settings.json', 'file', '{\n    "maintenance": false,\n    "currency": "USD"\n}\n');
  add('/var/www/html/storage/logs/laravel.log', 'file', '[2026-10-11 14:02:11] production.INFO: Invoice INV-10293 paid via Stripe\n[2026-10-11 14:05:40] production.WARNING: Slow query (1.21s) on services\n', '0664');
  add('/var/www/html/Modules/Billing/module.json', 'file', '{\n    "name": "Billing",\n    "active": true\n}\n');
  add('/var/www/html/public/index.php', 'file', "<?php\n\nrequire __DIR__.'/../vendor/autoload.php';\n");
  add('/var/www/html/public/favicon.ico', 'file', '\u0000\u0000\u0001\u0000', '0644');
  add('/var/www/html/storage/app/theme-backup.zip', 'file', 'PK\u0003\u0004', '0644');
  const sizeOf = f => f.type === 'directory' ? 4096 : new TextEncoder().encode(f.content).length;
  const perms = (type, mode) => (type === 'directory' ? 'd' : '-') + [6, 3, 0].map(s => { const v = (parseInt(mode, 8) >> s) & 7; return (v & 4 ? 'r' : '-') + (v & 2 ? 'w' : '-') + (v & 1 ? 'x' : '-'); }).join('');
  const describe = (path, f) => ({name: path === '/' ? '/' : path.split('/').pop(), type: f.type, size: sizeOf(f), mode: f.mode.padStart(4, '0'), permissions: perms(f.type, f.mode), owner: f.owner, group: f.group, modifiedAt: f.modifiedAt});
  const children = dir => [...files.keys()].filter(p => p !== dir && p.slice(0, p.lastIndexOf('/') || 1) === dir);
  const persistent = p => p === '/var/www/html/storage' || p.startsWith('/var/www/html/storage/');
  const err = (code, status = 400) => Object.assign(new Error(code), {code, status});
  const decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  const encode = text => { const bytes = new TextEncoder().encode(text); let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); };
  const uploads = new Map();
  function fs(b, tid, region) {
    const f = files.get(b.path);
    const needs = () => { if (!f) throw err('file_not_found', 404); return f; };
    const protectedPath = p => ['/', '/var/www', '/var/www/html', '/var/www/html/storage'].includes(p) || p.split('/').length < 3;
    if (b.user !== 'root' && f && f.owner === 'root' && !['list', 'stat', 'read'].includes(b.action)) throw err('permission_denied', 403);
    switch (b.action) {
      case 'list': {
        if (needs().type !== 'directory') throw err('not_a_directory', 409);
        const entries = children(b.path).map(p => describe(p, files.get(p))).sort((x, y) => (x.type === 'directory' ? 0 : 1) - (y.type === 'directory' ? 0 : 1) || x.name.localeCompare(y.name));
        return {path: b.path, entries, truncated: false, persistent: persistent(b.path), writable: true};
      }
      case 'read': needs(); if (f.type !== 'file') throw err('not_a_file', 409); return {path: b.path, contentBase64: encode(f.content), size: sizeOf(f), binary: f.content.includes('\u0000') || /^PK/.test(f.content), mode: f.mode, modifiedAt: f.modifiedAt, persistent: persistent(b.path)};
      case 'write': { const existing = files.get(b.path); if (existing && b.expectModifiedAt !== undefined && Math.abs(existing.modifiedAt - b.expectModifiedAt) > 1e-6) throw err('file_changed', 409); add(b.path, 'file', decode(b.contentBase64), existing?.mode || '0644'); note(region, tid, 'fs_write', {path: b.path, runAs: b.user}); return {path: b.path, writtenBytes: 1, modifiedAt: files.get(b.path).modifiedAt, persistent: persistent(b.path)}; }
      case 'create': if (f) throw err('file_exists', 409); add(b.path, 'file', ''); files.get(b.path).modifiedAt = Date.now() / 1000; return {path: b.path, created: true};
      case 'mkdir': if (f) throw err('file_exists', 409); add(b.path, 'directory'); files.get(b.path).modifiedAt = Date.now() / 1000; note(region, tid, 'fs_mkdir', {path: b.path, runAs: b.user}); return {path: b.path, created: true};
      case 'upload': {
        if (b.offset === 0 && f && !b.overwrite) throw err('file_exists', 409);
        uploads.set(b.uploadId, (uploads.get(b.uploadId) || '') + decode(b.contentBase64));
        if (b.final) { add(b.path, 'file', uploads.get(b.uploadId)); files.get(b.path).modifiedAt = Date.now() / 1000; uploads.delete(b.uploadId); note(region, tid, 'fs_upload', {path: b.path, runAs: b.user}); }
        return {path: b.path, receivedBytes: b.offset + 1, completed: b.final};
      }
      case 'rename': case 'copy': {
        needs(); if (files.has(b.destination)) throw err('file_exists', 409);
        if (b.action === 'rename' && protectedPath(b.path)) throw err('protected_path', 403);
        for (const p of [...files.keys()]) if (p === b.path || p.startsWith(b.path + '/')) { files.set(b.destination + p.slice(b.path.length), {...files.get(p)}); if (b.action === 'rename') files.delete(p); }
        note(region, tid, `fs_${b.action}`, {path: b.path, runAs: b.user}); return {path: b.path, destination: b.destination, done: true};
      }
      case 'delete': {
        needs(); if (protectedPath(b.path)) throw err('protected_path', 403);
        if (f.type === 'directory' && children(b.path).length && !b.recursive) throw err('directory_not_empty', 409);
        for (const p of [...files.keys()]) if (p === b.path || p.startsWith(b.path + '/')) files.delete(p);
        note(region, tid, 'fs_delete', {path: b.path, runAs: b.user}); return {path: b.path, deleted: true};
      }
      case 'chmod': { needs(); let changed = 0; for (const p of files.keys()) if (p === b.path || b.recursive && p.startsWith(b.path + '/')) { files.get(p).mode = b.mode.padStart(4, '0'); changed++; } note(region, tid, 'fs_chmod', {path: b.path, runAs: b.user}); return {path: b.path, mode: b.mode.padStart(4, '0'), changed}; }
      case 'chown': { needs(); const [o, g] = b.owner.split(':'); let changed = 0; for (const p of files.keys()) if (p === b.path || b.recursive && p.startsWith(b.path + '/')) { files.get(p).owner = o; files.get(p).group = g || o; changed++; } note(region, tid, 'fs_chown', {path: b.path, runAs: 'root'}); return {path: b.path, owner: b.owner, changed}; }
      case 'extract': return {path: b.path, destination: b.destination, extracted: 0, skipped: 0};
      default: throw err('invalid_action');
    }
  }
  function exec(b, t) {
    const cmd = b.command.trim();
    let cwd = b.cwd, stdout = '', stderr = '', exitCode = 0;
    if (/^cd(\s|$)/.test(cmd)) {
      const target = cmd.slice(2).trim() || '/var/www';
      const next = target.startsWith('/') ? target : `${cwd === '/' ? '' : cwd}/${target}`.replace(/\/[^/]+\/\.\.(?=\/|$)/g, '').replace(/\/\.$/, '');
      if (files.get(next)?.type === 'directory') cwd = next || '/'; else { stderr = `sh: 1: cd: can't cd to ${target}\n`; exitCode = 2; }
    } else if (cmd === 'pwd') stdout = `${cwd}\n`;
    else if (cmd === 'whoami') stdout = `${b.user}\n`;
    else if (cmd.startsWith('ls')) stdout = ['total 48', ...children(cwd).map(p => { const f = files.get(p); return `${perms(f.type, f.mode)}  1 ${f.owner.padEnd(8)} ${f.group.padEnd(8)} ${String(sizeOf(f)).padStart(6)} Oct 11 14:02 ${p.split('/').pop()}`; })].join('\n') + '\n';
    else if (cmd === 'php artisan about') stdout = '\n  Environment ........................................................\n  Application Name ............................................ Spartan\n  Laravel Version ............................................. 12.31.1\n  PHP Version .................................................. 8.4.13\n  Environment ............................................. production\n  Debug Mode ......................................................... OFF\n  URL ............................................ ' + t.url.replace('https://', '') + '\n\n  Drivers ............................................................\n  Cache ............................................................ file\n  Database ........................................................ mysql\n  Queue ........................................................ database\n  Session .......................................................... file\n';
    else if (cmd === 'php artisan migrate:status') stdout = '\n  Migration name .............................................. Batch / Status\n  0001_01_01_000000_create_users_table ................................ [1] Ran\n  0001_01_01_000001_create_cache_table ................................ [1] Ran\n  2026_09_02_101500_create_invoices_table ............................. [1] Ran\n  2026_10_01_090000_add_tax_rates_table ............................... [2] Ran\n';
    else if (cmd === 'php artisan optimize:clear') stdout = '\n   INFO  Clearing cached bootstrap files.\n\n  config ......................................................... 2ms DONE\n  cache .......................................................... 4ms DONE\n  compiled ....................................................... 1ms DONE\n  events ......................................................... 1ms DONE\n  routes ......................................................... 1ms DONE\n  views .......................................................... 6ms DONE\n';
    else if (cmd === 'php artisan queue:failed') stdout = '\n   INFO  No failed jobs found.\n\n';
    else if (cmd === 'df -h') stdout = 'Filesystem      Size  Used Avail Use% Mounted on\noverlay         320G  141G  179G  45% /\ntmpfs            64M     0   64M   0% /dev\n/dev/sda1       320G  141G  179G  45% /var/www/html/storage\n';
    else if (cmd.startsWith('ps aux')) stdout = 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\nwww-data      41 12.1  9.8 412044 201220 ?      Sl   Oct08  41:02 rr serve\nwww-data      44  3.2  4.1 188020  84112 ?      S    Oct08  10:11 php artisan queue:work\nroot           1  0.0  0.9  32412  19212 ?      Ss   Oct08   0:41 /usr/bin/python3 /usr/bin/supervisord\nwww-data      52  0.4  0.6  21232  12442 ?      S    Oct08   1:20 redis-server 127.0.0.1:6379\n';
    else if (cmd.startsWith('tail') && cmd.includes('laravel.log')) stdout = files.get('/var/www/html/storage/logs/laravel.log').content;
    else if (cmd.startsWith('echo ')) stdout = cmd.slice(5).replace(/^["']|["']$/g, '') + '\n';
    else if (cmd.startsWith('cat ')) { const p = cmd.slice(4).trim(); const full = p.startsWith('/') ? p : `${cwd}/${p}`; const f = files.get(full); if (f?.type === 'file') stdout = f.content; else { stderr = `cat: ${p}: No such file or directory\n`; exitCode = 1; } }
    else { stderr = `sh: 1: ${cmd.split(/\s+/)[0]}: not found\n`; exitCode = 127; }
    return {id: t.id, user: b.user, exitCode, stdout, stderr, cwd, durationMs: 120, timedOut: false, truncated: false};
  }
  function logs(t) {
    const base = Date.now() - 600000;
    const lines = [];
    const texts = ['INFO  Octane server listening on 127.0.0.1:8000', '127.0.0.1 - - "GET /dashboard HTTP/1.1" 200 18233', '127.0.0.1 - - "POST /api/invoices/10293/pay HTTP/1.1" 200 412', 'INFO  Processing jobs from the [critical,high,medium,default,low] queues.', '2026-10-11 14:02:11 App\\Jobs\\SendInvoiceEmail ........ RUNNING', '2026-10-11 14:02:12 App\\Jobs\\SendInvoiceEmail ........ 412.08ms DONE', '127.0.0.1 - - "GET /client/services HTTP/1.1" 200 9120', 'WARN  Slow query (1.21s): select * from `services` where `status` = ?', '127.0.0.1 - - "GET /favicon.ico HTTP/1.1" 200 1150', 'Running scheduled command: php artisan invoices:generate'];
    for (let i = 0; i < 60; i++) { const text = texts[i % texts.length]; lines.push({time: new Date(base + i * 9800).toISOString().replace('Z', '000000Z'), stream: text.startsWith('WARN') ? 'stderr' : 'stdout', text}); }
    return {id: t.id, lines, truncated: false};
  }
  const find = (region, tid) => tenants.find(t => t.region === region && t.id === tid);
  async function request(method, path, body) {
    await sleep(rand(120, 380));
    if (path === '/api/session') return {authenticated: true, user: 'admin', csrf: 'demo', label: 'Spartan Cloud', nodes: [{region: 'us', label: 'United States', host: host.us}, {region: 'de', label: 'Germany', host: host.de}], provisioning: {baseDomain: 'load.dezerx.cloud'}};
    if (path.startsWith('/api/instances')) return instanceRequest(method, path, body || {});
    if (path === '/api/overview') return {nodes: [node('us'), node('de')], sampledAt: new Date().toISOString()};
    if (path === '/api/activity') return {events: activity};
    if (path === '/api/logout') return {authenticated: false};
    const m = path.match(/^\/api\/nodes\/(us|de)\/tenants\/(t-[a-f0-9]{24})\/(.+)$/);
    const t = m && find(m[1], m[2]);
    if (!t) throw err('not_found', 404);
    const op = m[3];
    if (op === 'detail') {
      const r = resources(t);
      return {...strip(t), region: t.region, running: t.container.running, containerHealth: 'not_configured', applicationHealthy: t.container.running, versions: t.container.running ? {spartan: '4.12.0', laravel: '12.31.1', php: '8.4.13'} : null, storageBytes: 412 * MB + t.baseMem * 13000,
        resources: r && {cpuPercent: r.cpuPercent, memoryUsage: `${(r.memoryUsedBytes / MB).toFixed(1)}MiB / 2GiB`, memoryPercent: r.memoryUsedBytes / (2 * GB) * 100, networkIO: '1.2GB / 3.4GB', blockIO: '210MB / 960MB', processes: r.processes},
        sampledAt: new Date().toISOString(), container: {state: t.container.running ? 'running' : 'exited', running: t.container.running, startedAt: new Date(Date.now() - 2.6e8).toISOString(), restartCount: 1, createdAt: '2026-09-02T10:15:00Z', exitCode: 0, oomKilled: false}};
    }
    if (op === 'logs') return logs(t);
    if (op === 'exec') { note(t.region, t.id, 'exec', {runAs: body.user, command: body.command}); await sleep(rand(150, 500)); return exec(body, t); }
    if (op === 'fs') return fs(body, t.id, t.region);
    if (op === 'container') { await sleep(900); t.container = body.action === 'stop' ? {state: 'exited', running: false} : {state: 'running', running: true}; note(t.region, t.id, `container_${body.action}`); return {id: t.id, action: body.action, done: true}; }
    if (op === 'reload') { await sleep(700); note(t.region, t.id, 'reload'); return {id: t.id, reloaded: true}; }
    if (op === 'upgrade') { await sleep(1200); note(t.region, t.id, 'upgrade'); return {id: t.id, status: 'current', image}; }
    throw err('not_found', 404);
  }
  // Simulated create-instance flow: custom domains verify on the second check, deploys finish in ~12 s.
  const instances = new Map();
  const PRODUCTS = {SPARTANSTARTER_: 'Starter', SPARTANCLOUDPLUS_: 'Cloud Plus', SPARTANPROFESSIONAL_: 'Professional', SPARTANULTIMATE_: 'Ultimate', SPARTANDEV_: 'Developer'};
  const advance = item => {
    if (item.status !== 'deploying') return;
    const elapsed = Date.now() - item.started;
    item.steps = {primary: elapsed > 6000 ? 'done' : 'running', ...(elapsed > 6000 ? {secondary: elapsed > 10000 ? 'done' : 'running'} : {}), ...(elapsed > 10000 ? {routing: elapsed > 12000 ? 'done' : 'running'} : {})};
    if (elapsed > 12000) { item.status = 'ready'; note(item.primary, item.id, 'instance_ready'); }
  };
  async function instanceRequest(method, path, body) {
    if (path === '/api/instances' && method === 'GET') { instances.forEach(advance); return {instances: [...instances.values()].reverse()}; }
    if (path === '/api/instances') {
      const prefix = Object.keys(PRODUCTS).find(p => String(body.licenseKey).startsWith(p));
      if (!prefix || body.licenseKey.length < 16) throw err('invalid_license_key', 400);
      const domain = String(body.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (body.domain && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) throw err('invalid_domain', 400);
      const id = `t-${hex(24)}`;
      const hostname = domain || `${id}.load.dezerx.cloud`;
      const item = {id, primary: body.primary, secondary: body.primary === 'us' ? 'de' : 'us', hostname, custom: Boolean(domain), url: `https://${hostname}`, product: PRODUCTS[prefix], licenseHint: `${prefix}…${body.licenseKey.slice(-4)}`, customerId: body.customerId || 'dashboard', status: domain ? 'awaiting_dns' : 'ready_to_deploy', steps: {}, checks: 0, createdAt: new Date().toISOString(), createdBy: 'admin',
        dns: domain ? {stage: 'spartan_ownership', readyToProvision: false, checkedAt: new Date().toISOString(), records: [{type: 'CNAME', name: domain, target: 'load.dezerx.cloud', purpose: 'routing'}, {type: 'TXT', name: `_spartan-verification.${domain}`, value: hex(40), purpose: 'spartan_ownership'}]} : null};
      instances.set(id, item);
      note(item.primary, id, 'instance_create');
      return item;
    }
    const m = path.match(/^\/api\/instances\/(t-[a-f0-9]{24})(?:\/(\w+))?$/);
    const item = m && instances.get(m[1]);
    if (!item) throw err('instance_not_found', 404);
    advance(item);
    if (!m[2]) return item;
    if (m[2] === 'verify') {
      await sleep(900);
      if (++item.checks < 2) throw err('ownership_not_verified', 409);
      item.dns = {...item.dns, stage: 'ready_to_provision', readyToProvision: true, checkedAt: new Date().toISOString(), records: [...item.dns.records, {type: 'TXT', name: `_acme-challenge.${item.hostname}`, value: hex(43), purpose: 'certificate_validation'}]};
      if (item.status === 'awaiting_dns') item.status = 'ready_to_deploy';
      return item;
    }
    if (m[2] === 'deploy') {
      const a = body.initialAdmin || {};
      if (!a.displayName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email || '') || String(a.password || '').length < 8) throw err('invalid_initial_admin', 400);
      Object.assign(item, {status: 'deploying', started: Date.now(), steps: {primary: 'running'}, error: null});
      note(item.primary, item.id, 'instance_deploy');
      return item;
    }
    if (m[2] === 'discard') { instances.delete(item.id); return {discarded: true}; }
    throw err('not_found', 404);
  }
  function download() {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = 'Downloads are disabled in this preview.';
    document.getElementById('toasts').append(el); setTimeout(() => el.remove(), 3000);
  }
  window.SPARTAN_DEMO = {request, download};
})();
