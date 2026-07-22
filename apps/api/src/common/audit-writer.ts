// The append-only, hash-chained audit_log writer (ITGC-AC-10 / ITGC-AC-16), extracted so it has more than
// one caller. AuditInterceptor writes the ordinary request trail; PlatformAdminGuard writes REFUSALS on the
// platform-owner surface — and a guard cannot go through the interceptor, because Nest runs guards BEFORE
// interceptors, so a guard rejection never reaches one (that is precisely why denied god access used to
// leave no trace at all). Both must produce structurally identical rows — same chain, same trusted-hop IP,
// same request id — or the trail would be inconsistent about who did what from where.
import { sql, eq, isNull, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { DrizzleDb } from '../database/database.module';
import { auditLog } from '../database/schema';
import { logger, requestId } from '../observability/logger';

// ITGC-AC-16 — bind each audit row to the previous one. Altering/removing any past row breaks every later hash.
export function auditRowHash(prevHash: string | null, seq: number, r: { actor: string | null; tenantId: number | null; action: string | null; ip: string | null; requestId: string | null; status: string | null; meta: unknown }): string {
  const metaStr = r.meta == null ? '' : stableStringify(r.meta);
  return createHash('sha256').update(`${prevHash ?? ''}|${seq}|${r.tenantId ?? ''}|${r.actor ?? ''}|${r.action ?? ''}|${r.ip ?? ''}|${r.requestId ?? ''}|${r.status ?? ''}|${metaStr}`).digest('hex');
}

function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

// Derive the client IP for the audit trail. The X-Forwarded-For chain is client-appendable at the LEFT, so
// taking the first (leftmost) hop trusts a value the client controls — a spoofable audit IP (security review
// L-12). Instead trust only the rightmost `TRUSTED_PROXY_HOPS` entries (the ones your own reverse proxies
// prepend) and read the entry the OUTERMOST trusted proxy saw as the peer. Default 0 ⇒ trust no XFF and use
// the direct socket peer (`req.ip`); set it to the number of proxies in front of the API (e.g. 1 behind a
// single load balancer) so the real client IP is recovered without honoring a forged prefix.
export function auditClientIp(req: FastifyRequest): string | null {
  const hops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS ?? 0)) || 0);
  const peer = req.ip ?? null;
  if (hops === 0) return peer; // no trusted proxy → a client-supplied XFF is not trustworthy
  const fwd = req.headers?.['x-forwarded-for'];
  const chain = (typeof fwd === 'string' ? fwd.split(',') : Array.isArray(fwd) ? fwd.flatMap((v) => String(v).split(',')) : [])
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return peer;
  // The last `hops` entries were added by trusted proxies; the client-most trusted entry is at length-hops.
  return chain[Math.max(0, chain.length - hops)] ?? peer;
}

// Correlation id for the row — the caller's own header when present, else a fresh one.
export function auditRequestId(req: FastifyRequest): string {
  return (req.headers?.['x-request-id'] as string) || requestId();
}

// `METHOD /url` — the stable action string both callers record.
export function auditAction(req: FastifyRequest): string {
  const url = (req as { originalUrl?: string }).originalUrl ?? req.url ?? '';
  return `${(req.method ?? '').toUpperCase()} ${url}`;
}

export interface AuditRow {
  action: string;
  actor: string | null;
  tenantId: number | null;
  ip: string | null;
  requestId: string;
  status: 'success' | 'fail';
  meta?: Record<string, unknown>;
}

// Fire-and-forget audit write. Swallows all errors — a logging failure must NEVER break the request.
export async function writeAuditRow(db: DrizzleDb, row: AuditRow): Promise<void> {
  const { action, actor, tenantId, ip, requestId: rid, status } = row;
  const meta = row.meta;
  try {
    // Any request tx has already committed/rolled back (or, for a guard denial, never opened), so the proxy
    // routes this to the base connection. audit_log is FORCE-RLS (0002_rls.sql) — run in its own tx that
    // sets app.bypass_rls so the WITH CHECK policy admits the row even when tenant_id is NULL (system /
    // pre-auth events). We do NOT SET ROLE here: a swallowed SET-ROLE failure would leave the tx aborted
    // (25P02) and drop the audit row; the base connection role already holds INSERT and the bypass GUC
    // satisfies RLS.
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
      // ITGC-AC-16 — append to the per-tenant hash chain. Lock the latest row (FOR UPDATE) so concurrent
      // audit writes can't fork the chain; each hash binds the previous hash + this row's content.
      const [last] = await tx.select({ seq: auditLog.seq, hash: auditLog.hash }).from(auditLog)
        .where(tenantId == null ? isNull(auditLog.tenantId) : eq(auditLog.tenantId, tenantId))
        .orderBy(desc(auditLog.seq)).limit(1).for('update');
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? null;
      const hash = auditRowHash(prevHash, seq, { actor, tenantId, action, ip, requestId: rid, status, meta: meta ?? null });
      await tx.insert(auditLog).values({ actor, tenantId, action, ip, requestId: rid, status, meta: meta ?? null, seq, prevHash, hash });
    });
  } catch (e) {
    // Audit must never break the request. Log and move on.
    logger.warn({ err: (e as Error)?.message, action }, 'audit write failed');
  }
}
