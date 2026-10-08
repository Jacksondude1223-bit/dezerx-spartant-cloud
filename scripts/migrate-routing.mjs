import {readFile} from 'node:fs/promises';
import {signature} from '../workers/shared.js';

const base = process.env.SPARTAN_ROUTING_URL;
const secret = process.env.ROUTING_CONTROL_SECRET;
if (!base || !secret || secret.length < 32) throw new Error('routing_configuration_required');
if (new URL(base).protocol !== 'https:') throw new Error('https_required');

async function send(path, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const response = await fetch(new URL(path, base), {method: 'POST', body, redirect: 'manual', headers: {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(secret, timestamp, 'POST', path, body)}});
  return {status: response.status, body: await response.text()};
}

const file = process.argv[2];
if (!file) {
  throw new Error('route_file_required');
} else {
  const routes = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(routes)) throw new Error('route_file_must_be_an_array');
  let migrated = 0;
  let failed = 0;
  for (const route of routes) {
    const result = await send('/v1/routing/instances', {id: route.id, serviceId: route.serviceId, customerId: route.customerId, primary: route.primary, status: route.status, lifecycleVersion: route.lifecycleVersion});
    if (result.status === 200 || result.status === 201) migrated++;
    else { failed++; console.error(`failed ${route.id}: ${result.status} ${result.body}`); }
  }
  console.log(`routing records: ${migrated} migrated, ${failed} failed, ${routes.length} total`);
  if (failed) process.exitCode = 1;
}
