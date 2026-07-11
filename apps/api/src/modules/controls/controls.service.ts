import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { controlFindings, apTransactions, vendors, purchaseOrders, journalEntries, journalLines } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Continuous controls monitoring (Platform Phase 19 — B5; GRC-4 disposition + KCI, GOV-02). Detective controls
// that scan the books for red flags. Every detector runs over TENANT-SCOPED tables (ap_transactions, vendors,
// purchase_orders, journal_entries) so findings can never cross tenants; the monitor is read-only and posts
// NOTHING to the GL. Re-scans upsert by fingerprint (onConflictDoNothing), so a recurring issue isn't
// duplicated AND an already-dispositioned finding is never reset. Each finding carries the RCM control it
// relates to (rcm_ref) and is tracked to closure via a managed disposition (GOV-02). Strengthens the
// SOX/ICFR detective-control + continuous-monitoring story.
const CONTROLS = [
  { key: 'duplicate_invoice', label: 'ใบแจ้งหนี้ซ้ำ (ผู้ขาย+เลขที่)', label_en: 'Duplicate vendor invoice (vendor + invoice no)', severity: 'critical', rcm_ref: 'EXP-10' },
  { key: 'duplicate_amount', label: 'จ่ายซ้ำที่เป็นไปได้ (ผู้ขาย+ยอด)', label_en: 'Possible duplicate payment (vendor + amount)', severity: 'warning', rcm_ref: 'EXP-01' },
  { key: 'ghost_vendor', label: 'ผู้ขายซ้ำ/ผี (เลขผู้เสียภาษีซ้ำ)', label_en: 'Duplicate/ghost vendor (shared tax ID)', severity: 'warning', rcm_ref: 'EXP-02' },
  { key: 'split_po', label: 'แยกใบสั่งซื้อเลี่ยงวงเงินอนุมัติ', label_en: 'Split PO under approval threshold', severity: 'warning', rcm_ref: 'EXP-02' },
  { key: 'weekend_je', label: 'รายการบัญชีปรับปรุงลงในวันหยุด', label_en: 'Manual journal entry posted on a weekend', severity: 'warning', rcm_ref: 'GL-05' },
  { key: 'dormant_vendor', label: 'ผู้ขายไม่เคลื่อนไหวกลับมาทำรายการ', label_en: 'Dormant vendor reactivation', severity: 'warning', rcm_ref: 'EXP-05' },
] as const;
const RCM_OF: Record<string, string> = Object.fromEntries(CONTROLS.map((c) => [c.key, c.rcm_ref]));

// KCI thresholds (per-scan detector tuning). Kept as module constants — a per-tenant settings table is
// future work; changing these changes the finding population, not the disposition/closure workflow.
const SPLIT_PO_THRESHOLD = 50000; // THB approval ceiling that a split-PO pattern tries to stay under
const SPLIT_PO_WINDOW_DAYS = 7;   // POs to the same vendor within this window are one "spend event"
const DORMANT_DAYS = 180;         // a gap this long between a vendor's transactions = a reactivation

// A finding still needs action while its disposition is one of these; the rest are CLOSED (tracked to end).
const OPEN_DISPOSITIONS = ['open', 'investigating'] as const;
const CLOSE_DISPOSITIONS = ['remediated', 'accepted', 'false_positive'] as const;
const ALL_DISPOSITIONS = ['open', 'investigating', 'remediated', 'accepted', 'false_positive'] as const;
export type Disposition = (typeof ALL_DISPOSITIONS)[number];
const isClosing = (d: string): boolean => (CLOSE_DISPOSITIONS as readonly string[]).includes(d);

// Map an RCM control id to its family for the KCI by-family roll-up (matches build_rcm.py families).
function rcmFamily(ref: string | null | undefined): string {
  if (!ref) return 'Unmapped';
  if (ref.startsWith('EXP')) return 'Expenditure';
  if (ref.startsWith('GL')) return 'General Ledger';
  if (ref.startsWith('REV')) return 'Revenue & Cash';
  if (ref.startsWith('ITGC')) return 'ITGC';
  return 'Other';
}

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

@Injectable()
export class ControlsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  catalog() { return { controls: CONTROLS.map((c) => ({ ...c })) }; }

  private async upsert(user: JwtUser, f: { controlKey: string; severity: string; entityRef: string; detail: string; amount?: number | null; fingerprint: string }) {
    await this.db.insert(controlFindings).values({
      tenantId: user.tenantId ?? null, controlKey: f.controlKey, severity: f.severity, entityRef: f.entityRef,
      detail: f.detail, amount: f.amount != null ? String(f.amount) : null, status: 'open', fingerprint: f.fingerprint,
      rcmRef: RCM_OF[f.controlKey] ?? null, disposition: 'open',
    }).onConflictDoNothing();
  }

  // Run every detector over the caller's (RLS-scoped) data and upsert findings. Idempotent by fingerprint.
  async scan(user: JwtUser) {
    const db = this.db;
    const vkey = sql<string>`coalesce(${apTransactions.vendorName}, ${apTransactions.vendorId}::text, '?')`;
    let candidates = 0;

    // ── 1. Duplicate vendor invoice (EXP-10) ──
    const dupInv = await db.select({ vkey, inv: apTransactions.invoiceNo, c: sql<string>`count(*)`, amt: sql<string>`coalesce(sum(${apTransactions.amount}),0)` })
      .from(apTransactions).where(sql`coalesce(${apTransactions.invoiceNo}, '') <> ''`)
      .groupBy(vkey, apTransactions.invoiceNo).having(sql`count(*) > 1`);
    for (const r of dupInv) { await this.upsert(user, { controlKey: 'duplicate_invoice', severity: 'critical', entityRef: `${r.vkey}/${r.inv}`, detail: `ใบแจ้งหนี้เลขที่ ${r.inv} จาก ${r.vkey} ปรากฏ ${r.c} ครั้ง`, amount: Number(r.amt), fingerprint: `dupinv:${r.vkey}:${r.inv}` }); candidates++; }

    // ── 2. Possible duplicate payment (EXP-01) ──
    const dupAmt = await db.select({ vkey, amount: apTransactions.amount, c: sql<string>`count(*)` })
      .from(apTransactions).where(sql`coalesce(${apTransactions.amount}, 0) > 0`)
      .groupBy(vkey, apTransactions.amount).having(sql`count(*) > 1`);
    for (const r of dupAmt) { await this.upsert(user, { controlKey: 'duplicate_amount', severity: 'warning', entityRef: `${r.vkey}/${r.amount}`, detail: `มีบิลจาก ${r.vkey} ยอด ${Number(r.amount).toLocaleString()} ซ้ำ ${r.c} รายการ (อาจจ่ายซ้ำ)`, amount: Number(r.amount), fingerprint: `dupamt:${r.vkey}:${r.amount}` }); candidates++; }

    // ── 3. Ghost / duplicate vendor (EXP-02) ──
    // vendors.tax_id is encrypted at rest (ITGC-AC-19) with a random IV, so a SQL GROUP BY would compare
    // ciphertexts (never equal → detector silently blind). Group the DECRYPTED values in app code instead —
    // the schema read decrypts per row, and the vendor master is small per tenant.
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

    // ── 4. Split PO under the approval threshold (EXP-02) ──
    // Multiple non-Draft POs to the SAME vendor within a short window, each individually below the approval
    // ceiling but summing over it — the classic way to buy above one's DoA without an approval. Greedy
    // non-overlapping windows anchored on the earliest PO so re-scans fingerprint stably.
    //   NB purchase_orders has NO tenant_id (it is not row-RLS-scoped in this codebase), so we INNER JOIN the
    //   tenant-isolated vendors master and attribute a split to the vendor's tenant — under RLS a caller only
    //   sees POs to vendors it can see (its own + shared), so the detector never crosses tenants.
    const poRows = await db.select({ vkey: vendors.name, poNo: purchaseOrders.poNo, poDate: purchaseOrders.poDate, total: purchaseOrders.totalAmount })
      .from(purchaseOrders).innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(sql`${purchaseOrders.status} <> 'Draft' and ${purchaseOrders.poDate} is not null and coalesce(${purchaseOrders.totalAmount}, 0) > 0`);
    const poByVendor = new Map<string, { poNo: string; date: string; total: number }[]>();
    for (const r of poRows as { vkey: string; poNo: string; poDate: string | null; total: string | null }[]) {
      if (!r.poDate) continue;
      poByVendor.set(r.vkey, [...(poByVendor.get(r.vkey) ?? []), { poNo: r.poNo, date: r.poDate, total: Number(r.total ?? 0) }]);
    }
    for (const [vkey, pos] of poByVendor) {
      const sorted = pos.slice().sort((a, b) => a.date.localeCompare(b.date));
      let i = 0;
      while (i < sorted.length) {
        const anchor = sorted[i]!;
        const anchorMs = Date.parse(anchor.date);
        const win = [anchor];
        let j = i + 1;
        while (j < sorted.length && (Date.parse(sorted[j]!.date) - anchorMs) <= SPLIT_PO_WINDOW_DAYS * 86_400_000) { win.push(sorted[j]!); j++; }
        const sum = win.reduce((s, p) => s + p.total, 0);
        const allUnder = win.every((p) => p.total < SPLIT_PO_THRESHOLD);
        if (win.length >= 2 && allUnder && sum >= SPLIT_PO_THRESHOLD) {
          await this.upsert(user, { controlKey: 'split_po', severity: 'warning', entityRef: `${vkey}/${anchor.date}`, detail: `พบใบสั่งซื้อ ${win.length} ใบถึง ${vkey} ภายใน ${SPLIT_PO_WINDOW_DAYS} วัน (${win.map((p) => p.poNo).join(', ')}) แต่ละใบต่ำกว่าวงเงินอนุมัติ ${SPLIT_PO_THRESHOLD.toLocaleString()} แต่รวม ${sum.toLocaleString()} — อาจแยกใบเลี่ยงการอนุมัติ`, amount: sum, fingerprint: `splitpo:${vkey}:${anchor.date}` }); candidates++;
          i = j; // consume the whole window
        } else { i++; }
      }
    }

    // ── 5. Weekend / after-hours manual JE (GL-05) ──
    // A manual adjustment posted on a Saturday/Sunday is a classic management-override red flag. dow 0=Sun,
    // 6=Sat. No user input in the predicate → no injection sink.
    const weekendJes = await db.select({ entryNo: journalEntries.entryNo, entryDate: journalEntries.entryDate, memo: journalEntries.memo, amt: sql<string>`coalesce(sum(${journalLines.debit}),0)` })
      .from(journalEntries).leftJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalEntries.source, 'Manual'), sql`extract(dow from ${journalEntries.entryDate}) in (0,6)`))
      .groupBy(journalEntries.entryNo, journalEntries.entryDate, journalEntries.memo);
    for (const r of weekendJes as { entryNo: string; entryDate: string; memo: string | null; amt: string }[]) {
      await this.upsert(user, { controlKey: 'weekend_je', severity: 'warning', entityRef: r.entryNo, detail: `รายการปรับปรุงบัญชี ${r.entryNo} ลงวันที่ ${r.entryDate} (วันหยุดสุดสัปดาห์)${r.memo ? ` — ${r.memo}` : ''}`, amount: Number(r.amt), fingerprint: `weekendje:${r.entryNo}` }); candidates++;
    }

    // ── 6. Dormant-vendor reactivation (EXP-05) ──
    // A vendor with a long gap between transactions that suddenly transacts again — a dormant/parked vendor
    // being revived (possible fraud vector). Group per vendor in app code; flag any consecutive gap > N days.
    const apRows = await db.select({ vkey, date: sql<string | null>`coalesce(${apTransactions.invoiceDate}::text, ${apTransactions.createdAt}::text)`, amount: apTransactions.amount })
      .from(apTransactions);
    const apByVendor = new Map<string, { date: string; amount: number }[]>();
    for (const r of apRows as { vkey: string; date: string | null; amount: string | null }[]) {
      if (!r.date) continue;
      const d = r.date.slice(0, 10);
      apByVendor.set(r.vkey, [...(apByVendor.get(r.vkey) ?? []), { date: d, amount: Number(r.amount ?? 0) }]);
    }
    for (const [vkey, txns] of apByVendor) {
      const sorted = txns.slice().sort((a, b) => a.date.localeCompare(b.date));
      for (let k = 1; k < sorted.length; k++) {
        const prev = sorted[k - 1]!, cur = sorted[k]!;
        const gapDays = (Date.parse(cur.date) - Date.parse(prev.date)) / 86_400_000;
        if (gapDays > DORMANT_DAYS) {
          await this.upsert(user, { controlKey: 'dormant_vendor', severity: 'warning', entityRef: `${vkey}/${cur.date}`, detail: `ผู้ขาย ${vkey} ไม่มีรายการนาน ${Math.round(gapDays)} วัน (${prev.date} → ${cur.date}) แล้วกลับมาทำรายการ ยอด ${cur.amount.toLocaleString()}`, amount: cur.amount, fingerprint: `dormant:${vkey}:${cur.date}` }); candidates++;
        }
      }
    }

    return { scanned: true, candidates };
  }

  private toDto(r: any) {
    return {
      id: Number(r.id), control_key: r.controlKey, rcm_ref: r.rcmRef ?? RCM_OF[r.controlKey] ?? null,
      severity: r.severity, entity_ref: r.entityRef, detail: r.detail, amount: r.amount != null ? Number(r.amount) : null,
      status: r.status, disposition: r.disposition ?? 'open', owner: r.owner ?? null, due_date: r.dueDate ?? null,
      root_cause: r.rootCause ?? null, remediated_by: r.remediatedBy ?? null, remediated_at: r.remediatedAt ?? null,
      detected_at: r.detectedAt,
    };
  }

  async listFindings(_user: JwtUser, opts?: { status?: string; disposition?: string }) {
    const db = this.db;
    const wh: SQL[] = [];
    if (opts?.status) wh.push(eq(controlFindings.status, opts.status));
    if (opts?.disposition) wh.push(eq(controlFindings.disposition, opts.disposition));
    const base = db.select().from(controlFindings);
    const rows = await (wh.length ? base.where(wh.length === 1 ? wh[0] : and(...wh)) : base).orderBy(sql`${controlFindings.detectedAt} desc`);
    return { findings: rows.map((r: any) => this.toDto(r)) };
  }

  // Legacy quick-review action (kept for back-compat). Marks a finding reviewed/dismissed.
  async review(id: number, status: string, user: JwtUser) {
    const st = status === 'dismissed' ? 'dismissed' : 'reviewed';
    const upd = await this.db.update(controlFindings).set({ status: st, reviewedBy: user.username, reviewedAt: new Date() }).where(eq(controlFindings.id, id)).returning({ id: controlFindings.id });
    if (!upd.length) throw new NotFoundException({ code: 'FINDING_NOT_FOUND', message: 'Finding not found', messageTh: 'ไม่พบรายการตรวจพบ' });
    return { id, status: st };
  }

  // GOV-02 disposition: set an accountable owner + due date + root cause; closing dispositions
  // (remediated/accepted/false_positive) stamp who/when closed it. An open/investigating disposition keeps
  // the exception on the KCI open worklist.
  async disposition(id: number, body: { disposition: Disposition; owner?: string; due_date?: string; root_cause?: string }, user: JwtUser) {
    if (!(ALL_DISPOSITIONS as readonly string[]).includes(body.disposition))
      throw new BadRequestException({ code: 'INVALID_DISPOSITION', message: 'Unknown disposition', messageTh: 'สถานะการจัดการไม่ถูกต้อง' });
    const closing = isClosing(body.disposition);
    const set: Record<string, any> = { disposition: body.disposition };
    if (body.owner !== undefined) set.owner = body.owner || null;
    if (body.due_date !== undefined) set.dueDate = body.due_date || null;
    if (body.root_cause !== undefined) set.rootCause = body.root_cause || null;
    if (closing) {
      set.remediatedBy = user.username; set.remediatedAt = new Date();
      // keep the legacy status coherent so old UIs/queries still make sense
      set.status = body.disposition === 'false_positive' ? 'dismissed' : 'reviewed';
      set.reviewedBy = user.username; set.reviewedAt = new Date();
    } else {
      set.remediatedBy = null; set.remediatedAt = null; set.status = 'open';
    }
    const upd = await this.db.update(controlFindings).set(set).where(eq(controlFindings.id, id)).returning();
    if (!upd.length) throw new NotFoundException({ code: 'FINDING_NOT_FOUND', message: 'Finding not found', messageTh: 'ไม่พบรายการตรวจพบ' });
    return { finding: this.toDto(upd[0]) };
  }

  // GOV-02 KCI roll-up: open exceptions by detector / severity / RCM family, an overdue count, and the mean
  // time-to-remediate over closed findings. Aggregated in app code over the caller's RLS-scoped findings.
  async kci(_user: JwtUser) {
    const rows: any[] = await this.db.select().from(controlFindings);
    const today = ymd(new Date());
    const isOpen = (r: any) => (OPEN_DISPOSITIONS as readonly string[]).includes(r.disposition ?? 'open');

    let openCount = 0, overdue = 0;
    const byDisposition = new Map<string, number>();
    const bySeverity = new Map<string, number>();
    const byFamily = new Map<string, number>();
    const byDetector = new Map<string, { open: number; total: number }>();
    let mttrSum = 0, mttrN = 0;

    for (const r of rows) {
      const disp = (r.disposition ?? 'open') as string;
      byDisposition.set(disp, (byDisposition.get(disp) ?? 0) + 1);
      const det = byDetector.get(r.controlKey) ?? { open: 0, total: 0 };
      det.total++;
      if (isOpen(r)) {
        openCount++;
        det.open++;
        bySeverity.set(r.severity, (bySeverity.get(r.severity) ?? 0) + 1);
        const fam = rcmFamily(r.rcmRef ?? RCM_OF[r.controlKey]);
        byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
        if (r.dueDate && String(r.dueDate).slice(0, 10) < today) overdue++;
      }
      byDetector.set(r.controlKey, det);
      if (r.remediatedAt && r.detectedAt) {
        const days = (new Date(r.remediatedAt).getTime() - new Date(r.detectedAt).getTime()) / 86_400_000;
        if (days >= 0) { mttrSum += days; mttrN++; }
      }
    }

    const label = (k: string) => CONTROLS.find((c) => c.key === k)?.label_en ?? k;
    return {
      total_open: openCount,
      overdue,
      mttr_days: mttrN ? Math.round((mttrSum / mttrN) * 10) / 10 : null,
      by_disposition: ALL_DISPOSITIONS.map((d) => ({ disposition: d, count: byDisposition.get(d) ?? 0 })),
      by_severity: [...bySeverity.entries()].map(([severity, count]) => ({ severity, count })),
      by_detector: CONTROLS.map((c) => ({ control_key: c.key, label: label(c.key), rcm_ref: c.rcm_ref, open: byDetector.get(c.key)?.open ?? 0, total: byDetector.get(c.key)?.total ?? 0 })),
      by_family: [...byFamily.entries()].map(([family, open]) => ({ family, open })).sort((a, b) => b.open - a.open),
    };
  }
}
