import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { webhookIdempotency } from '../database/schema';

// SOX-ICFR audit finding #5 — inbound-webhook idempotency (replay defence for payments & delivery).
// HMAC + a timestamp window prove a webhook is authentic and bound how long a captured request survives,
// but they do NOT stop a duplicate being *processed* within the window. This service makes an authenticated
// event single-shot: the first delivery claims (source, key) and processes; any redelivery of the same key
// is acked as a duplicate and never re-runs the side effect (no double GL post / double settlement).
//
// PostgreSQL-backed (the audit trail is itself SOX evidence); the unique index `uq_webhook_idempotency` is
// the single arbiter, so two concurrent redeliveries can never both win. The table is platform-level (no
// RLS), so `claim()` works from any context — an @NoTx public webhook handler on the base pool, or inside a
// tenant transaction.
@Injectable()
export class WebhookIdempotencyService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Atomically claim `(source, key)`. Returns `'first'` (new — proceed to process) or `'duplicate'`
   * (already seen — the caller should ack and skip the side effect).
   *
   * Call this AFTER the signature/secret check (so an unauthenticated caller can't poison a key), and —
   * where the handler mutates inside a transaction — inside that same transaction, so a rolled-back handler
   * also rolls back the claim (a failed processing attempt must not block the legitimate retry).
   */
  async claim(source: string, key: string, aboutTenantId?: number | null): Promise<'first' | 'duplicate'> {
    const rows = await this.db
      .insert(webhookIdempotency)
      .values({ source, idemKey: key, aboutTenantId: aboutTenantId ?? null })
      .onConflictDoNothing()
      .returning({ id: webhookIdempotency.id });
    return rows.length ? 'first' : 'duplicate';
  }

  /**
   * Derive a stable idempotency key: prefer the provider's own event id; otherwise fall back to a sha256
   * content-hash of the raw body, so an identical replayed payload is still rejected even when the provider
   * sends no event id. (A signed replay re-sends byte-identical bytes, so the hash is stable across it.)
   */
  keyFor(eventId: string | null | undefined, rawBody?: Buffer | string): string {
    if (eventId && eventId.length) return `id:${eventId}`;
    const body = rawBody == null ? '' : typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    return `sha256:${createHash('sha256').update(body).digest('hex')}`;
  }
}
