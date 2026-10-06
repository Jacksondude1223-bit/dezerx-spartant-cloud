import {isIP} from 'node:net';
export function proxyHeaders(req, info) {
  const ip = req.headers['x-spartan-client-ip'];
  if (typeof ip !== 'string' || !isIP(ip)) throw new Error('invalid_client_ip');
  const headers = {...req.headers};
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-forwarded-') || ['forwarded', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-pseudo-ipv4', 'x-spartan-ingress-key', 'cf-access-client-id', 'cf-access-client-secret'].includes(key)) delete headers[key];
  }
  headers['x-forwarded-for'] = ip;
  headers['x-real-ip'] = ip;
  headers['cf-connecting-ip'] = ip;
  headers['x-forwarded-proto'] = 'https';
  if (info.local) {
    headers.host = req.headers['x-spartan-host'];
    headers['x-forwarded-host'] = headers.host;
    headers['x-spartan-ingress-key'] = info.record.appKey;
    for (const key of ['x-spartan-origin', 'x-spartan-host', 'x-spartan-hop', 'x-spartan-custom-domain']) delete headers[key];
  } else {
    headers.host = info.url.host;
    headers['x-spartan-hop'] = '1';
  }
  return headers;
}
