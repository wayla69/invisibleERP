import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { controlFindings, apTransactions, vendors } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Continuous controls monitoring (Platform Phase 19 — B5). Detective controls that scan the books for red
// flags. Every detector runs over TENANT-SCOPED tables (ap_transactions, vendors) so findings can never
// cross tenants; the monitor is read-only and posts NOTHING to the GL. Re-scans upsert by fingerprint, so a
// recurring issue isn't duplicated. Strengthens the SOX/ICFR detective-control story.
const CONTROLS = [
  { key: 'duplicate_invoice', label: 'ใบแจ้งหนี้ซ้ำ (ผู้ขาย+เลขที่)', label_en: 'Duplicate vendor invoice (vendor + invoice no)', severity: 'critical' },
  { key: 'duplicate_amount', label: 'จ่ายซ้ำที่เป็นไปได้ (ผู้ขาย+ยอด)', label_en: 'Possible duplicate payment (vendor + amount)', severity: 'warning' },
  { key: 'ghost_vendor', label: 'ผู้ขายซ้ำ/ผี (เลขผู้เสียภาษีซ้ำ)', label_en: 'Duplicate/ghost vendor (shared tax ID)', severity: 'warning' },
] as const;

@Injectable()
export class ControlsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  catalog() { return { controls: CONTROLS.map((c) => ({ ...c })) }; }

  private async upsert(user: JwtUser, f: { controlKey: string; severity: string; entityRef: string; detail: string; amount?: number | null; fingerprint: string }) {
    await this.db.insert(controlFindings).values({
      tenantId: user.tenantId ?? null, controlKey: f.controlKey, severity: f.severity, entityRef: f.entityRef,
      detail: f.detail, amount: f.amount != null ? String(f.amount) : null, status: 'open', fingerprint: f.fingerprint,
    }).onConflictDoNothing();
  }

  // Run every detector over the caller's (RLS-scoped) data and upsert findings. Idempotent by fingerprint.
  async scan(user: JwtUser) {
    const db = this.db;
    const vkey = sql<string>`coalesce(${apTransactions.vendorName}, ${apTransactions.vendorId}::text, '?')`;
    let candidates = 0;

    const dupInv = await db.select({ vkey, inv: apTransactions.invoiceNo, c: sql<string>`count(*)`, amt: sql<string>`coalesce(sum(${apTransactions.amount}),0)` })
      .from(apTransactions).where(sql`coalesce(${apTransactions.invoiceNo}, '') <> ''`)
      .groupBy(vkey, apTransactions.invoiceNo).having(sql`count(*) > 1`);
    for (const r of dupInv) { await this.upsert(user, { controlKey: 'duplicate_invoice', severity: 'critical', entityRef: `${r.vkey}/${r.inv}`, detail: `ใบแจ้งหนี้เลขที่ ${r.inv} จาก ${r.vkey} ปรากฏ ${r.c} ครั้ง`, amount: Number(r.amt), fingerprint: `dupinv:${r.vkey}:${r.inv}` }); candidates++; }

    const dupAmt = await db.select({ vkey, amount: apTransactions.amount, c: sql<string>`count(*)` })
      .from(apTransactions).where(sql`coalesce(${apTransactions.amount}, 0) > 0`)
      .groupBy(vkey, apTransactions.amount).having(sql`count(*) > 1`);
    for (const r of dupAmt) { await this.upsert(user, { controlKey: 'duplicate_amount', severity: 'warning', entityRef: `${r.vkey}/${r.amount}`, detail: `มีบิลจาก ${r.vkey} ยอด ${Number(r.amount).toLocaleString()} ซ้ำ ${r.c} รายการ (อาจจ่ายซ้ำ)`, amount: Number(r.amount), fingerprint: `dupamt:${r.vkey}:${r.amount}` }); candidates++; }

    // Ghost vendor: vendors.tax_id is encrypted at rest (ITGC-AC-19) with a random IV, so a SQL GROUP BY
    // would compare ciphertexts (never equal → detector silently blind). Group the DECRYPTED values in app
    // code instead — the schema read decrypts per row, and the vendor master is small per tenant.
    const vRows = await db.select({ tax: vendors.taxId, name: vendors.name }).from(vendors);
    const byTax = new Map<string, string[]>();
    for (const r of vRows as { tax: string | null; name: string }[]) {
      const tax = (r.tax ?? '').trim();
      if (!tax) continue;
      byTax.set(tax, [...(byTax.get(tax) ?? []), r.name]);
    }
    for (const [tax, names] of byTax) {
      if (names.length <= 1) continue;
      await this.upsert(user, { controlKey: 'ghost_vendor', severity: 'warning', entityRef: tax, detail: `เลขผู้เสียภาษี ${tax} ใช้ร่วมกัน ${names.length} ผู้ขาย: ${names.join(', ')}`, fingerprint: `ghost:${tax}` }); candidates++;
    }

    return { scanned: true, candidates };
  }

  async listFindings(_user: JwtUser, status?: string) {
    const db = this.db;
    const base = db.select().from(controlFindings);
    const rows = await (status ? base.where(eq(controlFindings.status, status)) : base).orderBy(sql`${controlFindings.detectedAt} desc`);
    return { findings: rows.map((r: any) => ({ id: Number(r.id), control_key: r.controlKey, severity: r.severity, entity_ref: r.entityRef, detail: r.detail, amount: r.amount != null ? Number(r.amount) : null, status: r.status, detected_at: r.detectedAt })) };
  }

  async review(id: number, status: string, user: JwtUser) {
    const st = status === 'dismissed' ? 'dismissed' : 'reviewed';
    const upd = await this.db.update(controlFindings).set({ status: st, reviewedBy: user.username, reviewedAt: new Date() }).where(eq(controlFindings.id, id)).returning({ id: controlFindings.id });
    if (!upd.length) throw new NotFoundException({ code: 'FINDING_NOT_FOUND', message: 'Finding not found', messageTh: 'ไม่พบรายการตรวจพบ' });
    return { id, status: st };
  }
}
