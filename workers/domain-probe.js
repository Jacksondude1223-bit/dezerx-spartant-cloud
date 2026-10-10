import {json, signature} from './shared.js';
import {readDomain, readRoute} from './store.js';

export const PROBE_PATH = '/__spartan_domain_probe';

async function proof(env, nonce, hostname, tenantId) {
  return signature(env.ORIGIN_SECRET, nonce, 'GET', PROBE_PATH, `${hostname}\n${tenantId}`);
}

export async function domainProbe(request, env) {
  const url = new URL(request.url);
  const nonce = url.searchParams.get('nonce');
  if (request.method !== 'GET' || url.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(nonce || '') || !env.DB || !env.ORIGIN_SECRET) return json({error: 'not_found'}, 404);
  const domain = await readDomain(env, url.hostname);
  if (!domain?.cloudflareId || !['pending_certificate', 'active'].includes(domain.status)) return json({error: 'not_found'}, 404);
  const tenant = await readRoute(env, domain.tenantId);
  if (!tenant || !['pending', 'ready'].includes(tenant.status)) return json({error: 'not_found'}, 404);
  return json({hostname: url.hostname, tenantId: domain.tenantId, nonce, signature: await proof(env, nonce, url.hostname, domain.tenantId)});
}

export async function reachesRouter(env, hostname, tenantId) {
  if (!env.ORIGIN_SECRET) return false;
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
  try {
    const response = await fetch(`https://${hostname}${PROBE_PATH}?nonce=${nonce}`, {redirect: 'manual', headers: {'accept': 'application/json', 'cache-control': 'no-cache'}, signal: AbortSignal.timeout(8000)});
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    let length = 0, chunks = [];
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2048) return false;
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return data.hostname === hostname && data.tenantId === tenantId && data.nonce === nonce && data.signature === await proof(env, nonce, hostname, tenantId);
  } catch { return false; }
}
