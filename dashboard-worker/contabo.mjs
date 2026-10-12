import {digest} from './crypto.mjs';
import {ApiError} from './store.mjs';

export const CONTABO_SETTINGS = ['CONTABO_CLIENT_ID', 'CONTABO_CLIENT_SECRET', 'CONTABO_API_USERNAME', 'CONTABO_API_PASSWORD'];
export const FIREWALL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const AUTH_URL = 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token';
const API_URL = 'https://api.contabo.com';
const caches = new WeakMap();
export const contaboSettings = env => ({configured: CONTABO_SETTINGS.every(name => typeof env[name] === 'string' && env[name].length > 0), missingSettings: CONTABO_SETTINGS.filter(name => typeof env[name] !== 'string' || !env[name])});

function port(value) {
  if (typeof value !== 'string' || !/^\d{1,5}(?:-\d{1,5})?$/.test(value)) throw new ApiError(422, 'invalid_firewall_ports');
  const [first, last = first] = value.split('-').map(Number);
  if (first > 65535 || last > 65535 || last < first) throw new ApiError(422, 'invalid_firewall_ports');
  return first === last ? String(first) : `${first}-${last}`;
}
function cidr(value, family) {
  if (value === (family === 4 ? 'AnyIPv4' : 'AnyIPv6')) return value;
  if (typeof value !== 'string') throw new ApiError(422, 'invalid_firewall_source');
  const parts = value.split('/'), address = parts[0];
  if (parts.length > 2 || (parts[1] !== undefined && !/^\d{1,3}$/.test(parts[1]))) throw new ApiError(422, 'invalid_firewall_source');
  const prefix = parts[1] === undefined ? (family === 4 ? 32 : 128) : Number(parts[1]);
  if (prefix > (family === 4 ? 32 : 128)) throw new ApiError(422, 'invalid_firewall_source');
  if (family === 4) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) || address.split('.').some(x => Number(x) > 255 || (x.length > 1 && x[0] === '0'))) throw new ApiError(422, 'invalid_firewall_source');
  } else {
    if (!address.includes(':') || /[^a-fA-F0-9:.]/.test(address)) throw new ApiError(422, 'invalid_firewall_source');
    try {new URL(`http://[${address}]/`);} catch {throw new ApiError(422, 'invalid_firewall_source');}
  }
  return `${address}/${prefix}`;
}
export function firewallRules(input) {
  if (!Array.isArray(input) || input.length > 250) throw new ApiError(422, 'invalid_firewall_rules');
  return input.map(rule => {
    if (!rule || !['tcp', 'udp', 'icmp', ''].includes(rule.protocol) || rule.action !== 'accept' || !['active', 'inactive'].includes(rule.status)) throw new ApiError(422, 'invalid_firewall_rule');
    if (!Array.isArray(rule.destPorts) || rule.destPorts.length > 100 || ((rule.protocol === 'icmp' || rule.protocol === '') && rule.destPorts.length)) throw new ApiError(422, 'invalid_firewall_ports');
    const srcCidr = {};
    for (const [name, family] of [['ipv4', 4], ['ipv6', 6]]) {
      const values = rule.srcCidr?.[name] || [];
      if (!Array.isArray(values) || values.length > 100) throw new ApiError(422, 'invalid_firewall_source');
      srcCidr[name] = [...new Set(values.map(value => cidr(value, family)))];
    }
    if (typeof rule.displayName !== 'string' || rule.displayName.length > 255 || /[\x00-\x1f\x7f]/.test(rule.displayName)) throw new ApiError(422, 'invalid_firewall_rule');
    return {protocol: rule.protocol, destPorts: [...new Set(rule.destPorts.map(port))], srcCidr, action: 'accept', status: rule.status, displayName: rule.displayName};
  });
}
const text = (value, required = false) => {
  if (typeof value !== 'string' || value.length > 255 || (required && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(422, 'invalid_firewall_name');
  return value;
};
function instanceView(value) {
  return {instanceId: value.instanceId, name: value.name || '', displayName: value.displayName || '', status: value.status || '', region: value.region || value.regionName || '', ipv4: value.ipConfig?.v4?.ip || '', ipv6: value.ipConfig?.v6?.ip || ''};
}
function rulesView(value) {
  return (value?.inbound || []).map(rule => {
    let destPorts = rule.destPorts || [];
    if (typeof destPorts === 'string') {try {destPorts = JSON.parse(destPorts);} catch {throw new ApiError(502, 'contabo_invalid_response');}}
    if (!Array.isArray(destPorts)) throw new ApiError(502, 'contabo_invalid_response');
    return {protocol: rule.protocol, destPorts, srcCidr: {ipv4: rule.srcCidr?.ipv4 || [], ipv6: rule.srcCidr?.ipv6 || []}, action: rule.action, status: rule.status, displayName: rule.displayName || ''};
  });
}
export async function firewallView(value) {
  if (!value || !FIREWALL_ID.test(value.firewallId)) throw new ApiError(502, 'contabo_invalid_response');
  const result = {firewallId: value.firewallId, name: value.name, description: value.description || '', status: value.status, rules: {inbound: rulesView(value.rules)}, instances: (value.instances || []).map(instanceView), instanceStatus: (value.instanceStatus || []).map(x => ({instanceId: x.instanceId, status: x.status})), createdDate: value.createdDate || '', updatedDate: value.updatedDate || ''};
  return {...result, version: await digest(JSON.stringify(result))};
}

export function contaboClient(env, fetchImpl = fetch) {
  if (!contaboSettings(env).configured) throw new ApiError(503, 'contabo_configuration_required');
  let cache = caches.get(fetchImpl);
  if (!cache) {cache = new Map(); caches.set(fetchImpl, cache);}
  const keyPromise = digest(JSON.stringify(CONTABO_SETTINGS.map(name => env[name])));
  const send = async (url, options) => {
    try {
      const result = await fetchImpl(url, {...options, redirect: 'manual', signal: AbortSignal.timeout(20000)});
      if (result.status >= 300 && result.status < 400) throw new ApiError(502, 'contabo_redirect_rejected');
      return result;
    } catch (error) {if (error instanceof ApiError) throw error; throw new ApiError(504, 'contabo_timeout');}
  };
  const token = async (invalidToken = '') => {
    const key = await keyPromise;
    if (invalidToken && cache.get(key)?.value === invalidToken) cache.delete(key);
    const current = cache.get(key);
    if (current?.pending) return current.pending;
    if (current?.expires > Date.now()) return current.value;
    const entry = {};
    entry.pending = (async () => {
      const body = new URLSearchParams({grant_type: 'password', client_id: env.CONTABO_CLIENT_ID, client_secret: env.CONTABO_CLIENT_SECRET, username: env.CONTABO_API_USERNAME, password: env.CONTABO_API_PASSWORD});
      const response = await send(AUTH_URL, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: body.toString()});
      if (!response.ok) throw new ApiError(502, response.status === 429 ? 'contabo_rate_limited' : 'contabo_auth_failed');
      let data; try {data = await response.json();} catch {throw new ApiError(502, 'contabo_invalid_response');}
      if (typeof data.access_token !== 'string' || !data.access_token || /\s/.test(data.access_token)) throw new ApiError(502, 'contabo_auth_failed');
      entry.value = data.access_token;
      entry.expires = Date.now() + Math.max(0, Math.min(Number(data.expires_in) || 60, 86400) - 30) * 1000;
      return entry.value;
    })();
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(key, entry);
    try {return await entry.pending;} catch (error) {cache.delete(key); throw error;} finally {delete entry.pending;}
  };
  const call = async (method, path, payload) => {
    if (!/^\/v1\/(?:firewalls(?:\/[a-f0-9-]+(?:\/instances\/\d+)?)?|compute\/instances)(?:\?page=\d+&size=100)?$/i.test(path)) throw new ApiError(400, 'invalid_contabo_path');
    let result, invalidToken = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await token(invalidToken);
      result = await send(API_URL + path, {method, headers: {authorization: 'Bearer ' + access, 'x-request-id': crypto.randomUUID(), 'content-type': 'application/json'}, ...(payload === undefined ? {} : {body: JSON.stringify(payload)})});
      if (result.status !== 401) break;
      invalidToken = access;
    }
    if (!result.ok) {
      const codes = {400: 'contabo_request_rejected', 401: 'contabo_auth_failed', 402: 'contabo_addon_required', 403: 'contabo_permission_denied', 404: 'contabo_not_found', 409: 'contabo_conflict', 429: 'contabo_rate_limited'};
      throw new ApiError(result.status === 404 ? 404 : result.status === 409 ? 409 : result.status === 400 ? 422 : 502, codes[result.status] || 'contabo_operation_failed');
    }
    if (result.status === 204) return {};
    try {return await result.json();} catch {throw new ApiError(502, 'contabo_invalid_response');}
  };
  const list = async path => {
    const rows = [];
    for (let page = 1; page <= 50; page++) {
      const result = await call('GET', `${path}?page=${page}&size=100`);
      if (!Array.isArray(result.data)) throw new ApiError(502, 'contabo_invalid_response');
      rows.push(...result.data);
      if (page >= Number(result._pagination?.totalPages || 1)) return rows;
    }
    throw new ApiError(502, 'contabo_list_limit');
  };
  return {call, list, async get(id) {return firewallView((await call('GET', '/v1/firewalls/' + id)).data?.[0]);}, async overview() {const [firewalls, instances] = await Promise.all([list('/v1/firewalls'), list('/v1/compute/instances')]); return {firewalls: await Promise.all(firewalls.map(firewallView)), instances: instances.map(instanceView)};}};
}

export async function firewallOperation(request, env, db, user, fetchImpl = fetch) {
  const path = new URL(request.url).pathname;
  if (path === '/api/firewall/config' && request.method === 'GET') return contaboSettings(env);
  const client = contaboClient(env, fetchImpl);
  if (path === '/api/firewall' && request.method === 'GET') return client.overview();
  const match = path.match(/^\/api\/firewall\/([a-f0-9-]+)(?:\/(update|rules|attach|detach|delete))?$/i);
  const create = path === '/api/firewall/create';
  if (!create && (!match || !FIREWALL_ID.test(match[1]))) throw new ApiError(404, 'not_found');
  if (!create && !match[2] && request.method === 'GET') return client.get(match[1]);
  if (request.method !== 'POST' || (!create && !match[2])) throw new ApiError(405, 'method_not_allowed');
  const {jsonBody} = await import('./auth.mjs');
  const input = await jsonBody(request, 192 * 1024);
  if (input.confirmed !== true) throw new ApiError(409, 'firewall_confirmation_required');
  const id = create ? 'create' : match[1], operation = create ? 'create' : match[2];
  let payload, method, endpoint;
  if (create) {payload = {name: text(input.name, true), description: text(input.description || ''), status: 'inactive', rules: {inbound: firewallRules(input.rules || [])}}; method = 'POST'; endpoint = '/v1/firewalls';}
  if (operation === 'update') {
    if (!['active', 'inactive'].includes(input.status)) throw new ApiError(422, 'invalid_firewall_status');
    payload = {name: text(input.name, true), description: text(input.description || ''), status: input.status}; method = 'PATCH'; endpoint = '/v1/firewalls/' + id;
  }
  if (operation === 'rules') {payload = {rules: {inbound: firewallRules(input.rules)}}; method = 'PUT'; endpoint = '/v1/firewalls/' + id;}
  if (operation === 'attach' || operation === 'detach') {
    if (!Number.isSafeInteger(input.instanceId) || input.instanceId < 1) throw new ApiError(422, 'invalid_contabo_instance');
    method = operation === 'attach' ? 'POST' : 'DELETE'; endpoint = `/v1/firewalls/${id}/instances/${input.instanceId}`;
  }
  if (operation === 'delete') {method = 'DELETE'; endpoint = '/v1/firewalls/' + id;}
  const lock = await db.lock('contabo-firewall:' + id, 300000);
  if (!lock) throw new ApiError(409, 'firewall_busy');
  try {
    if (!create) {
      const current = await client.get(id);
      if (input.version !== current.version) throw new ApiError(409, 'firewall_changed');
      if (operation === 'delete' && current.instances.length) throw new ApiError(409, 'firewall_has_instances');
      if (operation === 'detach' && !current.instances.some(x => x.instanceId === input.instanceId)) throw new ApiError(409, 'contabo_instance_not_attached');
    }
    await db.audit('firewall_change_started', {user, firewallId: id, action: operation});
    const result = await client.call(method, endpoint, payload);
    const firewallId = create ? result.data?.[0]?.firewallId : id;
    if (create && !FIREWALL_ID.test(firewallId || '')) throw new ApiError(502, 'contabo_invalid_response');
    await db.audit('firewall_change_completed', {user, firewallId, action: operation});
    return {ok: true, firewallId};
  } catch (error) {
    await db.audit('firewall_change_failed', {user, firewallId: id, action: operation, error: error instanceof ApiError ? error.message : 'operation_failed'});
    throw error;
  } finally {await db.unlock('contabo-firewall:' + id, lock);}
}
