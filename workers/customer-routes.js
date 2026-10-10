export async function customerRoute(env, hostname, create = false) {
  const token = env.CF_ROUTING_API_TOKEN || env.CF_INSTANCE_API_TOKEN || env.CF_SAAS_API_TOKEN;
  if (!token || !env.CLOUDFLARE_ZONE_ID || !env.ROUTING_WORKER_NAME) return {error: 'customer_route_configuration_required'};
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/workers/routes`;
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
  const response = await fetch(endpoint, {headers, signal: AbortSignal.timeout(8000)});
  const data = await response.json();
  if (!response.ok || !data.success || !Array.isArray(data.result)) return {error: 'customer_route_check_failed'};
  const pattern = `${hostname}/*`;
  const existing = data.result.find(route => route.pattern === pattern);
  if (existing) return existing.script === env.ROUTING_WORKER_NAME ? {ready: true} : {error: 'customer_route_conflict'};
  if (!create) return {ready: false};
  const created = await fetch(endpoint, {method: 'POST', headers, body: JSON.stringify({pattern, script: env.ROUTING_WORKER_NAME}), signal: AbortSignal.timeout(8000)});
  const result = await created.json();
  if (!created.ok || !result.success || result.result?.pattern !== pattern || result.result?.script !== env.ROUTING_WORKER_NAME) return {error: 'customer_route_setup_failed'};
  return {ready: true};
}
