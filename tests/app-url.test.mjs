import test from 'node:test';
import assert from 'node:assert/strict';
import {appUrl} from '../node/app-url.mjs';

const context = {baseDomain: 'cloud.provider.test', originHostnames: ['us.provider.test', 'de.provider.test']};

test('a customer domain is accepted and normalised', () => {
  assert.equal(appUrl('https://billing.customer.com', context), 'https://billing.customer.com');
  assert.equal(appUrl('https://billing.customer.com/', context), 'https://billing.customer.com', 'a trailing slash is not kept in APP_URL');
  assert.equal(appUrl('https://panel.co.uk', context), 'https://panel.co.uk');
});

test('the tenant subdomain is still a valid choice', () => {
  const id = `t-${'a'.repeat(24)}`;
  assert.equal(appUrl(`https://${id}.cloud.provider.test`, context), `https://${id}.cloud.provider.test`);
});

test('control-plane hostnames are refused so a tenant cannot point at them', () => {
  assert.equal(appUrl('https://cloud.provider.test', context), null, 'the base domain is the control host');
  assert.equal(appUrl('https://us.provider.test', context), null, 'a node origin would route back into the tunnel');
  assert.equal(appUrl('https://de.provider.test', context), null);
});

test('anything that is not a bare https origin is refused', () => {
  for (const value of [
    undefined, null, 42, '', 'billing.customer.com',
    'http://billing.customer.com',
    'https://billing.customer.com:8443',
    'https://billing.customer.com/panel',
    'https://billing.customer.com?x=1',
    'https://billing.customer.com#x',
    'https://user:pass@billing.customer.com',
    'https://localhost',
    'https://192.0.2.10',
    'https://no-dot',
    'https://-bad.customer.com',
    'https://BILLING.CUSTOMER.COM/extra/path',
    `https://${'a'.repeat(260)}.com`
  ]) assert.equal(appUrl(value, context), null, JSON.stringify(value));
});

test('an uppercase host is lowercased by URL parsing and still accepted', () => {
  assert.equal(appUrl('https://BILLING.Customer.COM', context), 'https://billing.customer.com');
});
