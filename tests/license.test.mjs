import test from 'node:test';
import assert from 'node:assert/strict';
import {productId, validLicenseKey} from '../node/license.mjs';

const body = 'a'.repeat(24);
test('product identifiers follow the licence tier prefix', () => {
  assert.equal(productId(`SPARTANSTARTER_${body}`), '1');
  assert.equal(productId(`SPARTANCLOUDPLUS_${body}`), '1');
  assert.equal(productId(`SPARTANPROFESSIONAL_${body}`), '5');
  assert.equal(productId(`SPARTANULTIMATE_${body}`), '6');
  assert.equal(productId(`SPARTANDEV_${body}`), '6');
  assert.throws(() => productId(`SPARTANFREE_${body}`), /invalid_license_key/);
  assert.throws(() => productId(undefined), /invalid_license_key/);
});

test('licence keys are accepted only in the form the vendor itself accepts', () => {
  for (const key of [`SPARTANSTARTER_${body}`, `SPARTANCLOUDPLUS_${body}`, `SPARTANULTIMATE_${'Z9-_'.repeat(6)}`]) assert.equal(validLicenseKey(key), true, key);
  for (const key of [
    undefined, null, 42, '',
    'SPARTANSTARTER_short'.slice(0, 15),
    `SPARTANSTARTER_${'a'.repeat(250)}`,
    `UNKNOWNTIER_${body}`,
    `SPARTANSTARTER_${body} with space`,
    `SPARTANSTARTER_${body}\nSECOND=line`,
    `SPARTANSTARTER_${body}'; DROP TABLE users; --`,
    `spartanstarter_${body}`
  ]) assert.equal(validLicenseKey(key), false, JSON.stringify(key));
});
