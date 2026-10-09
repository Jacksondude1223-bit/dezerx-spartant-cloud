import {readFile, writeFile, mkdir, chmod, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';

export function parseEnvironment(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || Object.hasOwn(env, match[1])) throw new Error('Invalid or duplicate environment entry');
    let value = match[2];
    if (value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\["\\])*"$/.test(value)) throw new Error('Invalid quoted environment value');
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (/[\s'"\\]/.test(value)) throw new Error('Use double quotes around environment values containing spaces');
    env[match[1]] = value;
  }
  return env;
}

export function serializeEnvironment(env) {
  return Object.entries(env).map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n') + '\n';
}

const domain = value => typeof value === 'string' && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) && !/(?:^|\.)example\.(?:com|net|org)$/.test(value);
const secret = value => typeof value === 'string' && value.length >= 32 && value.length <= 512 && !value.includes('CHANGE_ME') && !/[\x00-\x20\x7f]/.test(value);
const fields = {
  BASE_DOMAIN: {label: 'Tenant base domain (cloud.yourdomain.com)', valid: domain},
  US_ORIGIN: {label: 'US node origin (https://node-us.yourdomain.com)', valid: origin},
  DE_ORIGIN: {label: 'Germany node origin (https://node-de.yourdomain.com)', valid: origin},
  SPARTAN_IMAGE: {label: 'Published Spartan image (registry/name@sha256:digest)', valid: value => /^\S+@sha256:[a-f0-9]{64}$/.test(value || '') && !value.includes('example.com')},
  ORIGIN_SECRET: {label: 'Shared API and origin secret (same on both nodes, routing Worker and master website)', valid: secret, hidden: true},
  TENANT_CPUS: {label: 'CPU limit per tenant', default: '1', valid: value => /^(?:\d+)(?:\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= 256},
  TENANT_MEMORY: {label: 'Memory limit per tenant', default: '512m', valid: value => /^[1-9]\d*[mg]$/i.test(value)},
  MAX_TENANTS: {label: 'Maximum tenants on this node', default: '100', valid: value => /^[1-9]\d*$/.test(value) && Number(value) <= 100000},
  AI_RECOVERY_ENABLED: {label: 'Enable existing Llama recovery service (true/false)', default: 'false', valid: value => ['true', 'false'].includes(value)},
  AI_MAX_CALLS_PER_DAY: {default: '10', valid: value => /^[1-9]\d*$/.test(value) && Number(value) <= 20}
};
function origin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && domain(url.hostname) && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
export function validateNodeEnvironment(env, region) {
  if (!['us', 'de'].includes(region) || env.NODE_REGION !== region) throw new Error('Node region mismatch');
  for (const [key, field] of Object.entries(fields)) if (!field.valid(env[key] || '')) throw new Error(`Invalid ${key}`);
  if (env.NODE_CONTROL_SECRET !== undefined && !secret(env.NODE_CONTROL_SECRET)) throw new Error('Invalid NODE_CONTROL_SECRET');
  const origins = [new URL(env.US_ORIGIN).hostname, new URL(env.DE_ORIGIN).hostname];
  if (origins[0] === origins[1] || origins.some(host => host === env.BASE_DOMAIN || host.endsWith(`.${env.BASE_DOMAIN}`))) throw new Error('Origin hostnames must differ and be outside the tenant base domain');
  if (env.AGENT_PORT !== '8788' || env.DATA_ROOT !== '/srv/spartan-cloud' || env.MYSQL_SOCKET !== '/run/mysqld/mysqld.sock' || env.LARAVEL_ENV_FILE !== '/etc/spartan-cloud/laravel-env.json') throw new Error('Invalid node paths or port');
  if (env.AI_RECOVERY_ENABLED === 'true') {
    let url;
    try { url = new URL(env.AI_RECOVERY_URL); } catch { throw new Error('Invalid AI_RECOVERY_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/v1/recovery' || url.search || url.hash || !domain(url.hostname)) throw new Error('Invalid AI_RECOVERY_URL');
    if (!secret(env.AI_RECOVERY_SECRET)) throw new Error('Invalid AI_RECOVERY_SECRET');
  }
  for (const value of Object.values(env)) if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid environment value');
  return env;
}

export async function checkNodeHealth(env, {fetchImpl = fetch, attempts = 30, pause = () => new Promise(resolve => setTimeout(resolve, 1000))} = {}) {
  for (let i = 0; i < attempts; i++) {
      try {
        const response = await fetchImpl('http://127.0.0.1:8788/__cloud_node_health', {headers: {'x-spartan-origin': env.ORIGIN_SECRET}, signal: AbortSignal.timeout(1000), redirect: 'error'});
        const result = await response.json();
        if (response.ok && result.status === 'ready' && result.region === env.NODE_REGION) {
          const tunnel = await fetchImpl('http://127.0.0.1:8789/ready', {signal: AbortSignal.timeout(1000), redirect: 'error'});
          if (tunnel.status === 200) { return true; }
        }
      } catch {}
      if (i + 1 < attempts) await pause();
    }
    throw new Error('Node agent or tunnel failed its local readiness check; run journalctl -u spartan-agent -u spartan-tunnel');
}

async function optionalFile(filename) {
  try { return await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicWrite(filename, content) {
  const temp = `${filename}.tmp`;
  await writeFile(temp, content, {mode: 0o600});
  await chmod(temp, 0o600);
  await rename(temp, filename);
}
async function main(args) {
  const region = args.shift();
  if (!['us', 'de'].includes(region)) throw new Error('Use setup-node.mjs us|de');
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (['--non-interactive', '--check-health'].includes(flag)) options[flag] = true;
    else if (['--env', '--token', '--output'].includes(flag) && args[0] && !args[0].startsWith('--')) options[flag] = args.shift();
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  if (options['--check-health']) {
    const env = parseEnvironment(await readFile(options['--env'] || '/etc/spartan-cloud/node.env', 'utf8'));
    validateNodeEnvironment(env, region);
    await checkNodeHealth(env);
    console.log(`Node agent ready and Cloudflare Tunnel connected: ${region}`);
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let text;
  if (options['--env']) text = await readFile(path.resolve(options['--env']), 'utf8');
  else text = await optionalFile('/etc/spartan-cloud/node.env') ?? await optionalFile(path.join(root, 'generated', `${region}.env`));
  const supplied = text === null ? {} : parseEnvironment(text);
  if (supplied.NODE_REGION && supplied.NODE_REGION !== region) throw new Error('Existing configuration belongs to another region');
  const env = {NODE_REGION: region, DATA_ROOT: '/srv/spartan-cloud', AGENT_PORT: '8788', MYSQL_SOCKET: '/run/mysqld/mysqld.sock', LARAVEL_ENV_FILE: '/etc/spartan-cloud/laravel-env.json'};
  let muted = false;
  const output = new Writable({write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); }});
  const interactive = !options['--non-interactive'] && process.stdin.isTTY && process.stdout.isTTY;
  const rl = interactive ? createInterface({input: process.stdin, output, terminal: true}) : null;
  const ask = async (key, field) => {
    let value = supplied[key] ?? process.env[key] ?? field.default ?? '';
    if (field.valid(value)) return value;
    if (!rl) throw new Error(`Missing or invalid ${key}; supply --env and --token files or use an interactive terminal`);
    while (!field.valid(value)) {
      const prompt = `${field.label || key}: `;
      if (field.hidden) process.stdout.write(prompt);
      muted = Boolean(field.hidden);
      try { value = (await rl.question(field.hidden ? '' : prompt)).trim(); }
      finally { muted = false; if (field.hidden) process.stdout.write('\n'); }
      if (!field.valid(value)) process.stdout.write(`Invalid ${key}.\n`);
    }
    return value;
  };
  try {
    for (const [key, field] of Object.entries(fields)) env[key] = await ask(key, field);
    const legacyControlSecret = supplied.NODE_CONTROL_SECRET ?? process.env.NODE_CONTROL_SECRET;
    if (legacyControlSecret !== undefined && legacyControlSecret !== '') env.NODE_CONTROL_SECRET = legacyControlSecret;
    if (env.AI_RECOVERY_ENABLED === 'true') {
      env.AI_RECOVERY_URL = await ask('AI_RECOVERY_URL', {label: 'Existing recovery Worker URL (https://worker.workers.dev/v1/recovery)', valid: value => { try { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/v1/recovery'; } catch { return false; } }});
      env.AI_RECOVERY_SECRET = await ask('AI_RECOVERY_SECRET', {label: 'Shared recovery Worker secret', valid: secret, hidden: true});
    }
    validateNodeEnvironment(env, region);
    let token = options['--token'] ? await readFile(path.resolve(options['--token']), 'utf8') : await optionalFile('/etc/spartan-cloud/tunnel-token') ?? await optionalFile(path.join(root, 'generated', `${region}.tunnel-token`));
    const tokenField = {label: `Cloudflare Tunnel token for the ${region} node (ingress http://127.0.0.1:8788)`, hidden: true, valid: value => /^[A-Za-z0-9+/=_-]{20,16384}$/.test(value)};
    supplied.CLOUDFLARE_TUNNEL_TOKEN = token?.trim() || process.env.CLOUDFLARE_TUNNEL_TOKEN || '';
    token = await ask('CLOUDFLARE_TUNNEL_TOKEN', tokenField);
    const dest = path.resolve(options['--output'] || '/etc/spartan-cloud');
    await mkdir(dest, {recursive: true, mode: 0o700});
    await atomicWrite(path.join(dest, 'node.env'), serializeEnvironment(env));
    await atomicWrite(path.join(dest, 'tunnel-token'), token + '\n');
    await atomicWrite(path.join(dest, 'image'), env.SPARTAN_IMAGE + '\n');
    console.log(`Node configuration ready: ${region}`);
  } finally { rl?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
