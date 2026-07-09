import { describe, expect, it } from 'vitest';

import { assertPublicUrl, isPrivateIp, isPublicUrl } from '../src/common/net-guard';

// Unit tests for the SSRF guard (2.4 slice 8 — security-review H-1/L-6). isPrivateIp is pure; the URL
// asserts are exercised with LITERAL-IP hosts only (a hostname would hit real DNS — the resolver paths
// stay harness-tested). The hex-serialised IPv4-mapped-IPv6 cases pin the H-1 fix: the WHATWG URL parser
// serialises `[::ffff:169.254.169.254]` into HEX (`::ffff:a9fe:a9fe`), which a dotted-only match let
// through as "public".

describe('net-guard — isPrivateIp v4 (RFC1918 / loopback / link-local / CGNAT / reserved)', () => {
  it.each([
    ['10.0.0.1', true], ['10.255.255.255', true],
    ['127.0.0.1', true], ['0.0.0.0', true],
    ['169.254.169.254', true],                 // cloud metadata
    ['172.16.0.1', true], ['172.31.255.1', true],
    ['172.15.0.1', false], ['172.32.0.1', false], // just OUTSIDE the /12
    ['192.168.1.1', true],
    ['100.64.0.1', true], ['100.127.0.1', true], // CGNAT /10
    ['100.63.0.1', false], ['100.128.0.1', false],
    ['224.0.0.1', true], ['255.255.255.255', true], // multicast / reserved
    ['8.8.8.8', false], ['1.1.1.1', false], ['203.0.113.7', false],
  ] as const)('%s → private=%s', (ip, want) => {
    expect(isPrivateIp(ip)).toBe(want);
  });

  it('an unparseable string fails CLOSED (treated as private)', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('999.1.1.1')).toBe(true);
  });
});

describe('net-guard — isPrivateIp v6 (incl. the H-1 hex-serialised mapped forms)', () => {
  it.each([
    ['::1', true], ['::', true],
    ['::ffff:169.254.169.254', true],   // dotted mapped metadata
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.1.2.3', true],
    ['::ffff:8.8.8.8', false],          // dotted mapped PUBLIC v4 stays public
    ['::ffff:a9fe:a9fe', true],         // H-1: hex-serialised 169.254.169.254
    ['::ffff:7f00:1', true],            // H-1: hex-serialised 127.0.0.1
    ['::ffff:808:808', false],          // hex-serialised 8.8.8.8 — a PUBLIC embedded v4 stays public
    ['64:ff9b::8.8.8.8', true],         // NAT64 — fail closed
    ['fc00::1', true], ['fd12:3456::1', true],  // ULA fc00::/7
    ['fe80::1', true],                  // link-local
    ['ff02::1', true],                  // multicast
    ['2001:4860:4860::8888', false],    // Google DNS — genuinely public
    ['2606:4700:4700::1111', false],
  ] as const)('%s → private=%s', (ip, want) => {
    expect(isPrivateIp(ip)).toBe(want);
  });
});

describe('net-guard — assertPublicUrl / isPublicUrl (literal-IP hosts)', () => {
  const code = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e: any) { return e?.response?.code ?? String(e); }
    return 'NO_THROW';
  };

  it('a malformed URL is SSRF_BLOCKED', async () => {
    expect(await code(() => assertPublicUrl('not a url'))).toBe('SSRF_BLOCKED');
  });

  it('plain http is refused unless allowHttp is set', async () => {
    expect(await code(() => assertPublicUrl('http://8.8.8.8/hook'))).toBe('SSRF_BLOCKED');
    expect(await code(() => assertPublicUrl('http://8.8.8.8/hook', { allowHttp: true }))).toBe('NO_THROW');
  });

  it('private / loopback / metadata literals are refused, public literals pass', async () => {
    expect(await code(() => assertPublicUrl('https://169.254.169.254/latest/meta-data'))).toBe('SSRF_BLOCKED');
    expect(await code(() => assertPublicUrl('https://10.0.0.5/hook'))).toBe('SSRF_BLOCKED');
    expect(await code(() => assertPublicUrl('https://[::1]/hook'))).toBe('SSRF_BLOCKED');
    expect(await code(() => assertPublicUrl('https://8.8.8.8/hook'))).toBe('NO_THROW');
  });

  it('H-1: a bracketed mapped-IPv6 metadata literal (hex-serialised by the URL parser) is refused', async () => {
    expect(await code(() => assertPublicUrl('https://[::ffff:169.254.169.254]/'))).toBe('SSRF_BLOCKED');
    expect(await code(() => assertPublicUrl('https://[::ffff:127.0.0.1]/'))).toBe('SSRF_BLOCKED');
  });

  it('isPublicUrl is the non-throwing mirror (send path records blocked instead of 500ing)', async () => {
    expect(await isPublicUrl('https://8.8.8.8/hook')).toBe(true);
    expect(await isPublicUrl('https://192.168.1.10/hook')).toBe(false);
  });
});
