import {signature, validLicenseKey} from '../workers/shared.js';
const [serviceId, customerId, licenseKey, primary = 'us', domain] = process.argv.slice(2);
if (!serviceId || !customerId || !['us', 'de'].includes(primary)) throw new Error('service_customer_license_region_required');
if (!validLicenseKey(licenseKey)) throw new Error('license_key_required');
if (!process.env.SPARTAN_PROVISION_URL || !process.env.BILLING_WEBHOOK_SECRET) throw new Error('billing_configuration_required');
const path = '/v1/instances';
const adminFile = process.env.INITIAL_ADMIN_FILE;
const initialAdmin = adminFile ? JSON.parse(await (await import('node:fs/promises')).readFile(adminFile, 'utf8')) : undefined;
// The domain is the customer's own, and the licence is the one issued for it; without a
// domain the tenant starts on its routing subdomain.
const body = JSON.stringify({serviceId, customerId, primary, licenseKey, ...(domain ? {domain} : {}), ...(initialAdmin ? {initialAdmin} : {})});
const timestamp = String(Date.now());
const response = await fetch(new URL(path, process.env.SPARTAN_PROVISION_URL), {method: 'POST', body, headers: {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(process.env.BILLING_WEBHOOK_SECRET, timestamp, 'POST', path, body)}});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
