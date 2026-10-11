import {readFile} from 'node:fs/promises';

export async function networkPublicKey(region, read = readFile) {
  if (!['us', 'de'].includes(region)) return null;
  try {
    const publicKey = (await read('/etc/wireguard/spartan-db.pub', 'utf8')).trim();
    return /^[A-Za-z0-9+/]{43}=$/.test(publicKey) ? {region, publicKey} : null;
  } catch { return null; }
}
