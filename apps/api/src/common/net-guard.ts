// SSRF guard for tenant/user-supplied outbound URLs (e.g. registered webhook targets). Rejects non-public
// destinations so a tenant can't point the server at cloud-metadata (169.254.169.254), localhost, or an
// internal RFC1918/ULA service. Validate at REGISTER time AND again immediately before each send (re-resolve)
// to blunt DNS-rebinding: a hostname that resolved public at registration can be re-pointed at an internal IP.
import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Returns true if the literal IP (v4 or v6) is loopback / private / link-local / CGNAT / unspecified / ULA /
// IPv4-mapped-IPv6 — i.e. anything that must never be reachable from a tenant-controlled URL.
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip.toLowerCase());
  return true; // unparseable → treat as unsafe
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = p;
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 127) return true;                       // loopback
  if (a === 0) return true;                         // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true;          // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 100 && b! >= 64 && b! <= 127) return true;// 100.64.0.0/10 CGNAT
  if (a! >= 224) return true;                         // multicast / reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  if (ip === '::1' || ip === '::') return true;     // loopback / unspecified
  // IPv4-mapped / IPv4-compatible — the embedded v4 must be re-checked. Critically, the WHATWG URL
  // parser serialises a mapped-address LITERAL into HEX (`::ffff:a9fe:a9fe`), NOT the dotted form, so a
  // dotted-only match let `[::ffff:169.254.169.254]` (cloud metadata), `[::ffff:127.0.0.1]` (loopback)
  // and every `[::ffff:10.x]`/RFC1918 literal through as "public" (SSRF bypass). Handle BOTH forms.
  const dotted = ip.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // ::ffff:a.b.c.d or ::a.b.c.d
  if (dotted) return isPrivateV4(dotted[1]!);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // ::ffff:HHHH:HHHH (hex-serialised v4)
  if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    return isPrivateV4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  // Any other v4-embedding form we did not structurally parse (uncompressed mapped, NAT64 64:ff9b::/96,
  // IPv4-compatible ::x) must FAIL CLOSED rather than fall through to the head-group check below, which
  // reads an empty leading group for `::`-prefixed addresses and wrongly returns "public".
  if (/^::ffff:/i.test(ip) || /^64:ff9b:/i.test(ip) || /^::\d/.test(ip)) return true;
  const head = ip.split(':')[0];
  const h = parseInt(head || '0', 16);
  if ((h & 0xfe00) === 0xfc00) return true;          // fc00::/7 unique-local
  if ((h & 0xffc0) === 0xfe80) return true;          // fe80::/10 link-local
  if (head!.startsWith('ff')) return true;            // ff00::/8 multicast
  return false;
}

// Throws BadRequestException unless `raw` is a well-formed https URL (http allowed only when allowHttp) whose
// host is a public address. When the host is a name, EVERY resolved A/AAAA must be public.
export async function assertPublicUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw bad('URL is malformed'); }
  if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) {
    throw bad('URL must use https');
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip [] from bracketed IPv6
  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      ips = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw bad('URL host does not resolve');
    }
  }
  if (!ips.length) throw bad('URL host does not resolve');
  if (ips.some(isPrivateIp)) throw bad('URL resolves to a private, loopback, or link-local address');
}

// Non-throwing variant for the send path (best-effort delivery records a 'blocked' outcome instead of 500ing).
export async function isPublicUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<boolean> {
  try { await assertPublicUrl(raw, opts); return true; } catch { return false; }
}

function bad(reason: string): BadRequestException {
  return new BadRequestException({ code: 'SSRF_BLOCKED', message: `Refusing outbound request: ${reason}`, messageTh: 'ปฏิเสธปลายทางที่ไม่ปลอดภัย (อาจเป็นที่อยู่ภายใน)' });
}
