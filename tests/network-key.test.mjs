import test from 'node:test';
import assert from 'node:assert/strict';
import {networkPublicKey} from '../node/network-key.mjs';

test('network discovery reads only the public key and binds it to the node region', async () => {
  const publicKey = 'a'.repeat(43) + '=';
  assert.deepEqual(await networkPublicKey('de', async (file, encoding) => {
    assert.equal(file, '/etc/wireguard/spartan-db.pub');
    assert.equal(encoding, 'utf8');
    return publicKey + '\n';
  }), {region: 'de', publicKey});
  for (const value of ['', '[Interface]\nPrivateKey=secret', publicKey + '\nextra']) {
    assert.equal(await networkPublicKey('us', async () => value), null);
  }
  assert.equal(await networkPublicKey('us', async () => {throw new Error('missing');}), null);
});
