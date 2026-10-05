import {readFile, mkdir, writeFile, chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';

const cfg = {...process.env};
try {
  for (const line of (await readFile('.env', 'utf8')).split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && !cfg[match[1]]) cfg[match[1]] = match[2];
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_API_TOKEN', 'BASE_DOMAIN', 'US_HOSTNAME', 'DE_HOSTNAME', 'SPARTAN_IMAGE']) {
  if (!cfg[name] || cfg[name].includes('CHANGE_ME') || /[\s\r\n]/.test(cfg[name])) throw new Error(`missing_${name}`);
}
for (const name of ['BASE_DOMAIN', 'US_HOSTNAME', 'DE_HOSTNAME']) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(cfg[name]) || cfg[name].endsWith('.example.com')) throw new Error(`invalid_${name}`);
}
if (cfg.US_HOSTNAME === cfg.DE_HOSTNAME || [cfg.US_HOSTNAME, cfg.DE_HOSTNAME].some(x => x.endsWith(`.${cfg.BASE_DOMAIN}`))) throw new Error('origin_routing_loop');
if (!/^\S+@sha256:[a-f0-9]{64}$/.test(cfg.SPARTAN_IMAGE)) throw new Error('image_digest_required');
const directory = path.resolve('generated');
await mkdir(directory, {recursive: true, mode: 0o700});
const write = async (file, value) => { const dest = path.join(directory, file); await writeFile(dest, value, {mode: 0o600}); await chmod(dest, 0o600); };
let state;
try { state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = {accountId: cfg.CLOUDFLARE_ACCOUNT_ID, zoneId: cfg.CLOUDFLARE_ZONE_ID, baseDomain: cfg.BASE_DOMAIN, BILLING_WEBHOOK_SECRET: randomBytes(32).toString('hex'), NODE_CONTROL_SECRET: randomBytes(32).toString('hex'), ORIGIN_SECRET: randomBytes(32).toString('hex'), tunnels: {}}; }
if (state.accountId !== cfg.CLOUDFLARE_ACCOUNT_ID || state.zoneId !== cfg.CLOUDFLARE_ZONE_ID || state.baseDomain !== cfg.BASE_DOMAIN) throw new Error('configuration_conflict');
const api = async (method, resource, body) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${resource}`, {method, headers: {authorization: `Bearer ${cfg.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`cloudflare_${response.status}_${JSON.stringify(result.errors)}`);
  return result.result;
};
const zone = await api('GET', `/zones/${cfg.CLOUDFLARE_ZONE_ID}`);
for (const host of [cfg.BASE_DOMAIN, cfg.US_HOSTNAME, cfg.DE_HOSTNAME]) if (host !== zone.name && !host.endsWith(`.${zone.name}`)) throw new Error('zone_mismatch');
const account = `/accounts/${cfg.CLOUDFLARE_ACCOUNT_ID}`;
const dns = async (name, content) => {
  const records = await api('GET', `/zones/${cfg.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(name)}`);
  if (records.length && (records.length !== 1 || records[0].type !== 'CNAME' || records[0].content !== content)) throw new Error(`dns_conflict_${name}`);
  if (records.length) {
    if (!records[0].proxied) throw new Error(`dns_not_proxied_${name}`);
    return;
  }
  await api('POST', `/zones/${cfg.CLOUDFLARE_ZONE_ID}/dns_records`, {type: 'CNAME', name, content, proxied: true, ttl: 1});
};
for (const location of ['us', 'de']) {
  const hostname = cfg[`${location.toUpperCase()}_HOSTNAME`];
  if (state.tunnels[location] && state.tunnels[location].hostname !== hostname) throw new Error('tunnel_hostname_conflict');
  if (!state.tunnels[location]) {
    const tunnel = await api('POST', `${account}/cfd_tunnel`, {name: `spartan-${location}-${cfg.BASE_DOMAIN}`, config_src: 'cloudflare'});
    state.tunnels[location] = {id: tunnel.id, hostname};
    await write('state.json', JSON.stringify(state));
  }
  const tunnel = state.tunnels[location];
  await api('PUT', `${account}/cfd_tunnel/${tunnel.id}/configurations`, {config: {ingress: [{hostname, service: 'http://127.0.0.1:8788'}, {service: 'http_status:404'}]}});
  const token = await api('GET', `${account}/cfd_tunnel/${tunnel.id}/token`);
  await write(`${location}.tunnel-token`, token);
  await dns(hostname, `${tunnel.id}.cfargotunnel.com`);
  const env = {NODE_REGION: location, NODE_CONTROL_SECRET: state.NODE_CONTROL_SECRET, ORIGIN_SECRET: state.ORIGIN_SECRET, BASE_DOMAIN: cfg.BASE_DOMAIN, SPARTAN_IMAGE: cfg.SPARTAN_IMAGE, US_ORIGIN: `https://${cfg.US_HOSTNAME}`, DE_ORIGIN: `https://${cfg.DE_HOSTNAME}`, DATA_ROOT: '/srv/spartan-cloud', AGENT_PORT: '8788', TENANT_CPUS: cfg.TENANT_CPUS || '1', TENANT_MEMORY: cfg.TENANT_MEMORY || '512m', MAX_TENANTS: cfg.MAX_TENANTS || '100', LARAVEL_ENV_FILE: '/etc/spartan-cloud/laravel-env.json'};
  await write(`${location}.env`, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}
await dns(`*.${cfg.BASE_DOMAIN}`, `${state.tunnels.us.id}.cfargotunnel.com`);
const queues = await api('GET', `${account}/queues?per_page=100`);
for (const queue_name of ['spartan-provision', 'spartan-provision-dead']) {
  if (!queues.some(queue => queue.queue_name === queue_name)) await api('POST', `${account}/queues`, {queue_name});
}
const vars = {BASE_DOMAIN: cfg.BASE_DOMAIN, US_ORIGIN: `https://${cfg.US_HOSTNAME}`, DE_ORIGIN: `https://${cfg.DE_HOSTNAME}`};
const common = {account_id: cfg.CLOUDFLARE_ACCOUNT_ID, compatibility_date: '2026-10-01', vars, observability: {enabled: true}};
await write('provisioning.json', JSON.stringify({...common, name: 'spartan-provisioning', main: '../workers/provisioning.js', workers_dev: true, durable_objects: {bindings: [{name: 'TENANTS', class_name: 'Tenant'}]}, migrations: [{tag: 'v1', new_sqlite_classes: ['Tenant']}], queues: {producers: [{binding: 'PROVISION_QUEUE', queue: 'spartan-provision'}], consumers: [{queue: 'spartan-provision', max_batch_size: 1, max_retries: 5, dead_letter_queue: 'spartan-provision-dead'}]}}));
await write('routing.json', JSON.stringify({...common, name: 'spartan-routing', main: '../workers/routing.js', workers_dev: false, routes: [{pattern: `*.${cfg.BASE_DOMAIN}/*`, zone_id: cfg.CLOUDFLARE_ZONE_ID}], durable_objects: {bindings: [{name: 'TENANTS', class_name: 'Tenant', script_name: 'spartan-provisioning'}]}}));
await write('provisioning.secrets.json', JSON.stringify({BILLING_WEBHOOK_SECRET: state.BILLING_WEBHOOK_SECRET, NODE_CONTROL_SECRET: state.NODE_CONTROL_SECRET}));
await write('routing.secrets.json', JSON.stringify({ORIGIN_SECRET: state.ORIGIN_SECRET}));
await write('billing.env', `BILLING_WEBHOOK_SECRET=${state.BILLING_WEBHOOK_SECRET}\nSPARTAN_PROVISION_URL=CHANGE_ME\n`);
await write('state.json', JSON.stringify(state));
console.log('generated');
