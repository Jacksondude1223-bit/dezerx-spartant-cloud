import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {createWriteStream, constants} from 'node:fs';
import {open, link, rm} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export async function backupKey(filename, initialize = false) {
  if (initialize) {
    try {
      const file = await open(filename, 'wx', 0o600);
      try { await file.writeFile(randomBytes(32)); } finally { await file.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== 32 || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error('invalid_backup_key_permissions');
    return await file.readFile();
  } finally { await file.close(); }
}
async function publish(filename, write) {
  const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await write(temporary);
    await link(temporary, filename);
  } finally { await rm(temporary, {force: true}); }
}
export async function encryptBackup(input, filename, key) {
  const header = Buffer.concat([Buffer.from('SCB1'), randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(4), {authTagLength: 16});
  cipher.setAAD(header);
  await publish(filename, temporary => pipeline(input, cipher, async function* (source) {
    yield header;
    for await (const chunk of source) yield chunk;
    yield cipher.getAuthTag();
  }, createWriteStream(temporary, {flags: 'wx', mode: 0o600})));
}
export async function decryptBackup(filename, output, key) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 32) throw new Error('invalid_backup');
    const header = Buffer.alloc(16), tag = Buffer.alloc(16);
    await file.read(header, 0, 16, 0);
    await file.read(tag, 0, 16, stat.size - 16);
    if (header.subarray(0, 4).toString() !== 'SCB1') throw new Error('invalid_backup');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(4), {authTagLength: 16});
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await publish(output, temporary => pipeline(stat.size === 32 ? Readable.from([]) : file.createReadStream({start: 16, end: stat.size - 17, autoClose: false}), decipher, createWriteStream(temporary, {flags: 'wx', mode: 0o600})));
  } finally { await file.close(); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const keyFile = process.env.BACKUP_KEY_FILE || '/etc/spartan-cloud/backup.key';
  if (command === 'init' && args.length === 0) { await backupKey(keyFile, true); return; }
  const key = await backupKey(keyFile);
  if (command === 'encrypt' && args.length === 1) await encryptBackup(process.stdin, args[0], key);
  else if (command === 'decrypt' && args.length === 2) await decryptBackup(args[0], args[1], key);
  else throw new Error('invalid_backup_command');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('backup_crypto_failed'); process.exitCode = 1; });
