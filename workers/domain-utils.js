export function hostname(value, env) {
  if (typeof value !== 'string') throw new Error('invalid_hostname');
  const name = value.toLowerCase().replace(/\.$/, '');
  if (name.length > 200 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new Error('invalid_hostname');
  for (const blocked of [env.BASE_DOMAIN, env.SAAS_ZONE_DOMAIN, new URL(env.US_ORIGIN).hostname, new URL(env.DE_ORIGIN).hostname].filter(Boolean)) {
    if (name === blocked || name.endsWith(`.${blocked}`)) throw new Error('reserved_hostname');
  }
  return name;
}
export async function api(env, method, suffix, body) {
  if (!env.CF_SAAS_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) throw new Error('saas_configuration_required');
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames${suffix}`, {method, headers: {authorization: `Bearer ${env.CF_SAAS_API_TOKEN}`, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000)});
  const result = await response.json();
  if (!response.ok || !result.success) {
    const error = new Error(`cloudflare_${response.status}`);
    error.cloudflareCodes = (Array.isArray(result.errors) ? result.errors : []).map(item => item?.code).filter(Number.isSafeInteger).slice(0, 5);
    throw error;
  }
  return result.result;
}
export async function dns(name, type) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const response = await fetch(url, {headers: {accept: 'application/dns-json'}, signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('dns_unavailable');
  const data = await response.json();
  if (data.Status !== 0 || data.CD === true) return [];
  return data.Answer || [];
}
export function txt(value) {
  const chunks = value.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks) return value;
  try { return chunks.map(chunk => JSON.parse(chunk)).join(''); } catch { return ''; }
}
