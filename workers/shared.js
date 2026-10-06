export const ID = /^t-[a-f0-9]{24}$/;
export const REGIONS = new Set(['us', 'de']);
export const json = (value, status = 200) => Response.json(value, {status, headers: {'cache-control': 'no-store'}});
export function region(country) {
  return new Set('AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM TR UA VA'.split(' ')).has(country) ? 'de' : 'us';
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function signature(secret, timestamp, method, path, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${method}\n${path}\n${body}`)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function verify(request, body, secret) {
  const stamp = request.headers.get('x-spartan-timestamp');
  const supplied = request.headers.get('x-spartan-signature');
  if (!secret || !stamp || !/^\d+$/.test(stamp) || Math.abs(Date.now() - Number(stamp)) > 300000 || !/^[a-f0-9]{64}$/.test(supplied || '')) return false;
  const expected = await signature(secret, stamp, request.method, new URL(request.url).pathname, body);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return difference === 0;
}
export async function nodeCall(env, location, path, payload) {
  const origin = location === 'us' ? env.US_ORIGIN : env.DE_ORIGIN;
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const headers = {'content-type': 'application/json', 'x-spartan-timestamp': timestamp, 'x-spartan-signature': await signature(env.NODE_CONTROL_SECRET, timestamp, 'POST', path, body)};
  const response = await fetch(`${origin}${path}`, {method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(90000)});
  if (!response.ok) throw new Error(`node_${location}_${response.status}`);
  return response.json();
}

import {validInitialAdmin} from '../node/admin-validation.mjs';
export {validInitialAdmin};

export async function sealAdmin(admin, secret) {
  if (!secret) throw new Error('admin_secret_missing');
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(admin))));
  return btoa(String.fromCharCode(...iv, ...ciphertext));
}
export async function openAdmin(value, secret) {
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(0, 12)}, key, bytes.slice(12));
  const admin = JSON.parse(new TextDecoder().decode(plaintext));
  if (!validInitialAdmin(admin)) throw new Error('invalid_initial_admin');
  return admin;
}
