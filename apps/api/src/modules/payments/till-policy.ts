import { eq, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { tillSettings } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Blind drawer close policy (0418, docs/50 Wave 1 — POS roadmap P1c; strengthens REV-13/REV-05).
// With blind_close ON the cashier counts the drawer WITHOUT seeing the system-expected cash:
// the X/Z read surfaces redact the drawer-expectation figures on an OPEN session for till-duty
// callers (a manager holding 'ar'/'exec' still sees them); closeTill reveals expected/variance
// only AFTER the count is submitted, and stamps the session as blind-closed for audit evidence.
// A ctor-body plain class (not a DI provider) so the PaymentService facade keeps its positional
// ctor unchanged — same pattern as projects-evm/resourcing (service-size ratchet, docs/46 §4).
export class TillPolicy {
  constructor(private readonly db: DrizzleDb) {}

  /** GET /api/payments/till/settings — tenant row ?? NULL-tenant default row ?? code default (off). */
  async getSettings(user: JwtUser): Promise<{ blind_close: boolean }> {
    return { blind_close: await this.blindOn(user.tenantId ?? null) };
  }

  /** PUT /api/payments/till/settings — manager-only (controller gates to 'ar'/'exec'); upsert per tenant. */
  async putSettings(dto: { blind_close?: boolean }, user: JwtUser) {
    const db = this.db;
    const [ex] = await db.select().from(tillSettings)
      .where(user.tenantId != null ? eq(tillSettings.tenantId, user.tenantId) : isNull(tillSettings.tenantId)).limit(1);
    const vals = { blindClose: !!dto.blind_close, updatedBy: user.username, updatedAt: new Date() };
    if (ex) await db.update(tillSettings).set(vals).where(eq(tillSettings.id, ex.id));
    else await db.insert(tillSettings).values({ tenantId: user.tenantId ?? null, ...vals });
    return { blind_close: !!dto.blind_close, updated_by: user.username };
  }

  async blindOn(tenantId: number | null): Promise<boolean> {
    const db = this.db;
    const rows = tenantId != null
      ? await db.select().from(tillSettings).where(eq(tillSettings.tenantId, tenantId)).limit(1)
      : await db.select().from(tillSettings).where(isNull(tillSettings.tenantId)).limit(1);
    return !!rows[0]?.blindClose;
  }

  /** Manager view = duty that supervises the till count ('ar' finance / 'exec'); Admin resolves both. */
  managerView(user: JwtUser): boolean {
    const p = user.permissions ?? [];
    return p.includes('ar') || p.includes('exec');
  }

  /** True when the OPEN session's aggregates must be redacted for this caller. */
  async mustRedact(user: JwtUser, tenantId: number | null): Promise<boolean> {
    return !this.managerView(user) && (await this.blindOn(tenantId));
  }

  /** Null out every figure the expected drawer cash can be derived from (expected itself, the cash
   *  aggregates, and the Cash tender amount — counts stay visible so the tape is still useful). */
  redactBlind<T extends Record<string, any>>(a: T): T & { blind: true } {
    return {
      ...a,
      cash_sales: null, cash_refunds: null, expected_cash: null,
      paid_in: null, paid_out: null, drops: null,
      by_method: (a.by_method ?? []).map((m: any) => (m.method === 'Cash' ? { ...m, amount: null } : m)),
      blind: true as const,
    };
  }
}
