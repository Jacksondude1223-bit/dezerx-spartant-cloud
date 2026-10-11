const encoder = new TextEncoder();
export const bytes = text => encoder.encode(text);
export const hex = value => [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, '0')).join('');
export const base64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));
export const unbase64 = value => Uint8Array.from(atob(value), x => x.charCodeAt(0));
export const random = (length = 32) => hex(crypto.getRandomValues(new Uint8Array(length)));
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', bytes(value)));
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
export async function hmac(secret, value, hash = 'SHA-256', raw = false) {
  const key = await crypto.subtle.importKey('raw', typeof secret === 'string' ? bytes(secret) : secret, {name: 'HMAC', hash}, false, ['sign']);
  const result = await crypto.subtle.sign('HMAC', key, typeof value === 'string' ? bytes(value) : value);
  return raw ? new Uint8Array(result) : hex(result);
}
export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Password must be 12 to 1024 characters');
  const key = await crypto.subtle.importKey('raw', bytes(password), 'PBKDF2', false, ['deriveBits']);
  const result = await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000}, key, 256);
  return `pbkdf2$100000$${base64(salt)}$${base64(result)}`;
}
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2' || parts[1] !== '100000' || typeof password !== 'string' || password.length > 1024 || unbase64(parts[2]).length !== 16 || unbase64(parts[3]).length !== 32) return false;
    return equal(await hashPassword(password, unbase64(parts[2])), stored);
  } catch { return false; }
}
async function dataKey(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('DASHBOARD_DATA_KEY must be 64 lowercase hexadecimal characters');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), x => parseInt(x, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret, purpose, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: bytes(purpose)}, await dataKey(secret), bytes(JSON.stringify(value)));
  return `${base64(iv)}.${base64(cipher)}`;
}
export async function open(secret, purpose, value) {
  const [iv, cipher, extra] = value.split('.');
  if (extra !== undefined || unbase64(iv).length !== 12) throw new Error('Invalid encrypted record');
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unbase64(iv), additionalData: bytes(purpose)}, await dataKey(secret), unbase64(cipher));
  return JSON.parse(new TextDecoder().decode(plain));
}
export async function totpCounter(secret, code, now = Date.now()) {
  if (!/^[0-9]{6}$/.test(code || '') || !/^[A-Z2-7]{16,128}$/.test(secret || '')) return null;
  let acc = 0, bits = 0;
  const key = [];
  for (const char of secret) {
    acc = (acc << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5;
    if (bits >= 8) {key.push((acc >>> (bits - 8)) & 255); bits -= 8;}
  }
  const step = Math.floor(now / 30000);
  for (const counter of [step - 1, step, step + 1]) {
    const message = new Uint8Array(8);
    new DataView(message.buffer).setBigUint64(0, BigInt(counter));
    const result = await hmac(Uint8Array.from(key), message, 'SHA-1', true);
    const offset = result.at(-1) & 15;
    const value = String((new DataView(result.buffer).getUint32(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
    if (equal(value, code)) return counter;
  }
  return null;
}
