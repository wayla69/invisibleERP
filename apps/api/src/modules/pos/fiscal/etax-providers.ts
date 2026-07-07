// Pluggable e-Tax Service-Provider adapter (docs/ops/etax-production-spike.md gap #3 — code-side hardening).
// No SP contract exists yet, so this generalizes the ONE adapter we can build without guessing a specific
// vendor's real API shape: a configurable generic HTTP submitter (auth scheme, status vocabulary, transient
// retry — all env-driven) so wiring in a real SP (INET / Frank / Leceipt / other) later is a config change,
// not new code. Mirrors the class-per-provider + factory shape of `payments/gateways.ts`.
import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';

export interface EtaxSubmitDoc { xml: string; signed: boolean }
export interface EtaxSubmitResult { status: string; providerRef: string; rd: any }

export interface EtaxProvider {
  submit(docNo: string, doc: EtaxSubmitDoc): Promise<EtaxSubmitResult>;
}

// ── mock: acks immediately (CI + when no SP is configured) ──
export class MockEtaxProvider implements EtaxProvider {
  async submit(docNo: string, doc: EtaxSubmitDoc): Promise<EtaxSubmitResult> {
    return { status: 'Accepted', providerRef: `mock-${docNo}`, rd: { code: '0', message: 'accepted (sandbox)', signed: doc.signed } };
  }
}

// Known status vocabulary → our three canonical values (Pending | Accepted | Rejected, see etax_submissions
// schema). An SP's exact wording varies; normalize the common synonyms, but pass through anything unrecognized
// verbatim rather than guessing — better a visible odd string than a silently wrong bucket.
function normalizeStatus(raw: unknown, httpOk: boolean): string {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (['accepted', 'success', 'ok', 'completed', 'approved'].includes(s)) return 'Accepted';
  if (['rejected', 'failed', 'error', 'declined', 'denied'].includes(s)) return 'Rejected';
  if (['pending', 'processing', 'queued', 'received'].includes(s)) return 'Pending';
  if (typeof raw === 'string' && raw) return raw; // unrecognized but explicit — keep as-is, don't mask it
  return httpOk ? 'Accepted' : 'Rejected';
}

// ── auth scheme (env-driven; 'bearer' kept as the default to stay backward compatible with the existing
// ETAX_PROVIDER_TOKEN/_AUTH_HEADER envs from before this file existed) ──
function authHeaders(body: string): Record<string, string> {
  const scheme = (process.env.ETAX_PROVIDER_AUTH_SCHEME || (process.env.ETAX_PROVIDER_TOKEN ? 'bearer' : 'none')).toLowerCase();
  if (scheme === 'bearer') {
    const token = process.env.ETAX_PROVIDER_TOKEN;
    if (!token) return {};
    return { [process.env.ETAX_PROVIDER_AUTH_HEADER || 'Authorization']: `Bearer ${token}` };
  }
  if (scheme === 'apikey') {
    const key = process.env.ETAX_PROVIDER_API_KEY;
    if (!key) return {};
    return { [process.env.ETAX_PROVIDER_API_KEY_HEADER || 'X-API-Key']: key };
  }
  if (scheme === 'basic') {
    const user = process.env.ETAX_PROVIDER_BASIC_USER, pass = process.env.ETAX_PROVIDER_BASIC_PASS;
    if (!user || pass == null) return {};
    return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
  }
  if (scheme === 'hmac') {
    const secret = process.env.ETAX_PROVIDER_HMAC_SECRET;
    if (!secret) return {};
    const timestamp = new Date().toISOString();
    const signature = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return {
      [process.env.ETAX_PROVIDER_SIG_HEADER || 'X-Signature']: signature,
      [process.env.ETAX_PROVIDER_TS_HEADER || 'X-Timestamp']: timestamp,
    };
  }
  return {}; // 'none' — some SPs gate by network/mTLS rather than a header
}

// Bounded retry for TRANSIENT failures only (network error / 5xx) — a 4xx means the request itself is wrong
// (bad payload, bad auth, misconfiguration) and retrying it changes nothing, so those are never retried here.
// This is independent of, and much shorter-lived than, EtaxService.retryFailed's cross-time submission sweep
// (gap #5): that sweep handles "the SP was down for an hour"; this handles "one TCP blip mid-request".
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const maxRetries = Number(process.env.ETAX_PROVIDER_MAX_RETRIES ?? 2);
  const baseMs = Number(process.env.ETAX_PROVIDER_RETRY_BASE_MS ?? 300);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || attempt === maxRetries) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) throw e;
    }
    await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
  }
  throw lastErr;
}

// ── generic http adapter — drop-in for any SP whose API is a JSON POST + one of the auth schemes above ──
export class HttpEtaxProvider implements EtaxProvider {
  async submit(docNo: string, doc: EtaxSubmitDoc): Promise<EtaxSubmitResult> {
    const url = process.env.ETAX_PROVIDER_URL;
    if (!url) throw new BadRequestException({ code: 'ETAX_PROVIDER_NOT_CONFIGURED', message: 'ETAX_PROVIDER_URL is not set', messageTh: 'ยังไม่ได้ตั้งค่า ETAX_PROVIDER_URL' });
    const body = JSON.stringify({ doc_no: docNo, signed: doc.signed, xml: doc.xml });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders(body) };
    const resp = await fetchWithRetry(url, { method: 'POST', headers, body });
    let respBody: any = {};
    try { respBody = await resp.json(); } catch { /* non-JSON SP response */ }
    const status = normalizeStatus(respBody.status, resp.ok);
    const providerRef = respBody.ref ?? respBody.providerRef ?? respBody.id ?? `http-${docNo}`;
    return { status, providerRef, rd: { http_status: resp.status, ...respBody, signed: doc.signed } };
  }
}

export type EtaxProviderName = 'mock' | 'http';

// INET / Frank / Leceipt etc. would each get their own class here (or map onto HttpEtaxProvider via the
// generic auth-scheme config above) once a real contract exists — no SP is wired in without one.
export function resolveEtaxProvider(name: string): { provider: EtaxProvider; name: string } {
  if (name === 'mock') return { provider: new MockEtaxProvider(), name: 'mock' };
  if (name === 'http') return { provider: new HttpEtaxProvider(), name: 'http' };
  // Unknown provider name: surface the SAME "not configured" shape HttpEtaxProvider would for a missing URL,
  // so callers don't need a separate branch for "unknown name" vs "known name, missing config".
  return {
    provider: {
      async submit(): Promise<EtaxSubmitResult> {
        throw new BadRequestException({ code: 'ETAX_PROVIDER_NOT_CONFIGURED', message: `e-Tax provider ${name} not configured`, messageTh: 'ยังไม่ได้ตั้งค่าผู้ให้บริการ e-Tax' });
      },
    },
    name,
  };
}
