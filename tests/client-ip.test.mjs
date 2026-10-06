import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyHeaders} from '../node/client-ip.mjs';
import {visitorIp, validClientIp} from '../workers/shared.js';

test('visitor IP validation accepts IPv4 and IPv6 and rejects chains, ports and malformed input', () => {
  for (const ip of ['198.51.100.42', '2001:db8::42', '::ffff:192.0.2.1']) assert.equal(validClientIp(ip), true);
  for (const ip of [undefined, '', '999.0.0.1', '01.2.3.4', '198.51.100.42, 203.0.113.1', '198.51.100.42:443', '[2001:db8::1]', 'fe80::1%eth0', '::gg', '1:2:3:4:5:6:7:8:9']) assert.equal(validClientIp(ip), false);
});
test('Pseudo IPv4 recovers the real IPv6 address without trusting arbitrary IPv6 headers', () => {
  assert.equal(visitorIp(new Headers({'cf-connecting-ip': '240.0.0.1', 'cf-connecting-ipv6': '2001:db8::42'})), '2001:db8::42');
  assert.equal(visitorIp(new Headers({'cf-connecting-ip': '198.51.100.42', 'cf-connecting-ipv6': '2001:db8::fake'})), '198.51.100.42');
  assert.equal(visitorIp(new Headers({'x-forwarded-for': '198.51.100.42'})), null);
});
test('node hop retains validated visitor IP and replaces proxy or spoofed headers before Laravel', () => {
  for (const ip of ['198.51.100.42', '2001:db8::42']) {
    const request = {headers: {'x-spartan-client-ip': ip, 'x-spartan-origin': 'origin-secret', 'x-spartan-host': 'billing.customer.test', 'x-spartan-ingress-key': 'attacker', 'x-forwarded-for': 'attacker', 'x-real-ip': 'attacker', 'cf-connecting-ip': 'proxy-ip', 'cf-connecting-ipv6': 'attacker', 'true-client-ip': 'attacker', forwarded: 'for=attacker', cookie: 'session=ok'}};
    const relay = proxyHeaders(request, {local: false, url: new URL('https://us.origin.test')});
    assert.equal(relay['x-spartan-client-ip'], ip);
    assert.equal(relay['x-spartan-hop'], '1');
    assert.equal(relay['x-spartan-ingress-key'], undefined);
    relay['cf-connecting-ip'] = 'different-cloudflare-proxy';
    const final = proxyHeaders({headers: relay}, {local: true, record: {appKey: 'tenant-key'}});
    assert.equal(final['x-spartan-client-ip'], ip);
    assert.equal(final['x-forwarded-for'], ip);
    assert.equal(final['x-real-ip'], ip);
    assert.equal(final['cf-connecting-ip'], ip);
    assert.equal(final['x-spartan-ingress-key'], 'tenant-key');
    assert.equal(final['x-spartan-origin'], undefined);
    assert.equal(final.forwarded, undefined);
    assert.equal(final['true-client-ip'], undefined);
    assert.equal(final.cookie, 'session=ok');
  }
});
test('agent refuses missing or malformed visitor IP instead of using supplied forwarding chains', () => {
  for (const ip of [undefined, 'invalid', '198.51.100.42, 203.0.113.1']) assert.throws(() => proxyHeaders({headers: {'x-spartan-client-ip': ip, 'x-forwarded-for': '198.51.100.42'}}, {local: false}), /invalid_client_ip/);
});
