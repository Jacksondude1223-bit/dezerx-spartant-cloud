const encoder = new TextEncoder();
const purpose = 'spartan-domain-provision-v1';

async function mac(payload, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}\n${payload}`)))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function issueDomainPermit(secret, id, hostname, now = Date.now()) {
  if (!secret || secret.length < 32) throw new Error('domain_permit_secret_missing');
  const expiresAt = now + 600000;
  const payload = btoa(JSON.stringify({purpose, id, hostname, expiresAt}));
  return {token: `${payload}.${await mac(payload, secret)}`, expiresAt};
}

export async function verifyDomainPermit(token, secret, id, hostname, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 2048 || !secret || secret.length < 32) return false;
    const [payload, signature, extra] = token.split('.');
    if (extra !== undefined || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
    const expected = await mac(payload, secret);
    let different = 0;
    for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    if (different) return false;
    const claim = JSON.parse(atob(payload));
    return claim.purpose === purpose && claim.id === id && claim.hostname === hostname
      && Number.isSafeInteger(claim.expiresAt) && claim.expiresAt > now && claim.expiresAt <= now + 900000;
  } catch { return false; }
}
