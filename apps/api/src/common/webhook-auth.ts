import { timingSafeEqual } from 'node:crypto';
import { verifyWebhookSignature } from './crypto';

// Inbound-webhook authentication (security review L-2). The delivery-aggregator / inbound-email webhooks were
// authenticated by a STATIC shared secret echoed in a header — a leaked secret alone lets anyone forge any
// body, and there is no replay binding. This helper upgrades them, backward-compatibly:
//
//   • If an HMAC signing secret is configured for the source, require an HMAC-SHA256 signature over the RAW
//     body (so the secret proves possession AND binds to the exact payload). When the sender also includes a
//     timestamp, it must be fresh and covered by the signature — a captured request can't be replayed later.
//   • Otherwise fall back to the legacy static shared-secret compare, so senders that haven't migrated to
//     HMAC keep working unchanged.
//   • With neither configured, returns 'unconfigured' so the caller can fail-closed in production.

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export type WebhookAuthResult = 'ok' | 'bad' | 'stale' | 'unconfigured';

export function verifyInboundWebhook(opts: {
  rawBody?: Buffer | string;
  staticSecret?: string;         // legacy shared secret (env), compared to providedSecret
  providedSecret?: string;       // the x-*-secret header value
  hmacSecret?: string;           // optional HMAC signing secret (env) — when set, HMAC is REQUIRED
  signature?: string;            // the x-*-signature header value (hex, optional `sha256=` prefix)
  timestamp?: string | number;   // optional freshness value (unix seconds)
  toleranceSec?: number;         // replay window when a timestamp is supplied (default 300s)
}): WebhookAuthResult {
  const { rawBody, staticSecret, providedSecret, hmacSecret, signature, timestamp, toleranceSec = 300 } = opts;
  if (hmacSecret) {
    const body = rawBody == null ? Buffer.from('') : typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
    if (timestamp !== undefined && timestamp !== null && String(timestamp) !== '') {
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return 'stale';
      const signed = Buffer.concat([Buffer.from(`${String(timestamp)}.`), body]);
      return verifyWebhookSignature(hmacSecret, signed, signature) ? 'ok' : 'bad';
    }
    return verifyWebhookSignature(hmacSecret, body, signature) ? 'ok' : 'bad';
  }
  if (staticSecret) {
    return providedSecret && safeEqualStr(providedSecret, staticSecret) ? 'ok' : 'bad';
  }
  return 'unconfigured';
}
