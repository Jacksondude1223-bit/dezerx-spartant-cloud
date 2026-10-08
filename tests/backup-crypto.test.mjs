import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat, readdir, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {backupKey, encryptBackup, decryptBackup} from '../node/backup-crypto.mjs';

test('backup encryption restores exact data, authenticates ciphertext and never publishes failed decryptions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spartan-crypto-'));
  try {
    const keyFile = path.join(dir, 'key');
    const key = await backupKey(keyFile, true);
    assert.deepEqual(await backupKey(keyFile, true), key);
    const original = Buffer.concat([Buffer.from('LICENSE_KEY=private-license\nDB_PASSWORD=private-password\n'), randomBytes(200000)]);
    const encrypted = path.join(dir, 'data.enc');
    await encryptBackup(Readable.from([original.subarray(0, 123), original.subarray(123)]), encrypted, key);
    const ciphertext = await readFile(encrypted);
    assert.equal(ciphertext.includes(Buffer.from('private-password')), false);
    assert.equal((await stat(encrypted)).mode & 0o077, 0);
    const restored = path.join(dir, 'restored');
    await decryptBackup(encrypted, restored, key);
    assert.deepEqual(await readFile(restored), original);
    await assert.rejects(decryptBackup(encrypted, path.join(dir, 'wrong-key'), randomBytes(32)));
    for (const offset of [4, 24, ciphertext.length - 1]) {
      const damaged = Buffer.from(ciphertext); damaged[offset] ^= 1;
      const filename = path.join(dir, `damaged-${offset}`);
      await writeFile(filename, damaged);
      await assert.rejects(decryptBackup(filename, path.join(dir, `failed-${offset}`), key));
    }
    assert.equal((await readdir(dir)).some(name => name.startsWith('failed-') || name === 'wrong-key' || name.endsWith('.tmp')), false);
    await assert.rejects(encryptBackup(Readable.from(['overwrite']), encrypted, key));
    assert.deepEqual(await readFile(encrypted), ciphertext);
    await chmod(keyFile, 0o644);
    await assert.rejects(backupKey(keyFile), /permissions/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
