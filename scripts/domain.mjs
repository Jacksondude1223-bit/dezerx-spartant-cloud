import {signature, ID} from '../workers/shared.js';
const [id, action, hostname] = process.argv.slice(2);
if (!ID.test(id || '') || !['reserve', 'verify', 'status', 'delete'].includes(action) || !hostname || !process.env.SPARTAN_PROVISION_URL || !process.env.BILLING_WEBHOOK_SECRET) throw new Error('tenant_action_hostname_configuration_required');
const path = `/v1/instances/${id}/domains/${action}`;
const body = JSON.stringify({hostname});
const timestamp = String(Date.now());
const response = await fetch(new URL(path, process.env.SPARTAN_PROVISION_URL), {method: 'POST', body, headers: {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(process.env.BILLING_WEBHOOK_SECRET, timestamp, 'POST', path, body)}});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
