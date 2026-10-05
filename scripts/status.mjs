import {signature, ID} from '../workers/shared.js';
const [id] = process.argv.slice(2);
if (!ID.test(id || '') || !process.env.SPARTAN_PROVISION_URL || !process.env.BILLING_WEBHOOK_SECRET) throw new Error('configuration_required');
const path = `/v1/instances/${id}`;
const timestamp = String(Date.now());
const response = await fetch(new URL(path, process.env.SPARTAN_PROVISION_URL), {headers: {'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(process.env.BILLING_WEBHOOK_SECRET, timestamp, 'GET', path, '')}});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
