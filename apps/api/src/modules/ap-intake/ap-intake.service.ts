import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq, and, ne, desc, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apInvoiceIntakes, apTransactions, purchaseOrders, poItems, vendors, fxRates } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { DocAiService } from '../doc-ai/doc-ai.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { FinanceService } from '../finance/finance.service';
import { putObject, objectUrl, isObjectRef } from '../../common/object-storage';
import { parseInvoiceDataUrl } from '../../common/invoice-doc';
import { blindIndex } from '../../database/encrypted-column';
import { mapVisionLinesToPo, type MappedMatchLine, type VisionLine } from './ap-intake.match-lines';

// AP invoice intake (EXP-10): scanned/pasted vendor invoice → doc-ai extraction → PO auto-map →
// post AP bill → automated 3-way match. Automates the path TO payment-ready only — the disbursement
// itself stays behind the EXP-01 match gate and the AP-PAY maker-checker (EXP-06). Anything the mapper
// cannot resolve unambiguously queues as NeedsReview for a human instead of guessing.
const AUTO_MAP_MIN = 85;   // vendor + amount must both agree before we map without a human
const RUNNER_UP_GAP = 15;  // and no near-tie with the second-best PO

// Upload/capture document validation (accepted types + size caps) lives in common/invoice-doc.ts so the
// AP-intake, doc-ai and Quick Capture surfaces share one allow-list (parseInvoiceDataUrl).

type PoCandidate = { po_no: string; vendor_name: string | null; total_amount: number; score: number };

// A vendor invoice may reference any APPROVED PO regardless of receipt progress — a fully-received PO is
// auto-'Closed' (procurement.service) and that is exactly when the invoice usually arrives. Only
// unapproved (Draft/Pending, EXP-03) and Cancelled POs are unmappable.
const MAPPABLE_PO_STATUS = ['Approved', 'Received', 'Closed'] as const;

@Injectable()
export class ApIntakeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly docAi: DocAiService,
    private readonly matchSvc: ThreeWayMatchService,
    private readonly finance: FinanceService,
  ) {}

  // ── Step 1: extract + auto-map. Creates the intake row (Mapped or NeedsReview). ──
  async create(text: string, user: JwtUser) {
    const { fields, source } = await this.docAi.extractInvoice(text, user);
    return this.receive({ fields, source, rawText: text }, user);
  }

  // ── Step 1, upload channel: an image or PDF (base64 data: URL, per the object-storage convention).
  // A digital PDF extracts via its text layer (deterministic); a scan/image extracts via Claude vision
  // when a key is set, else it queues as NeedsReview with the document stored for a human. ──
  async createFromFile(dto: { file_name?: string; data_url: string }, user: JwtUser) {
    const doc = parseInvoiceDataUrl(dto.data_url);
    const ext = await this.docAi.extractInvoiceDocument({ media_type: doc.mime, data: doc.base64 }, user);
    return this.receive({
      fields: ext.fields, source: ext.source, rawText: ext.text || null,
      file: { name: (dto.file_name ?? 'document').slice(0, 200), mime: doc.mime, dataUrl: doc.dataUrl },
    }, user);
  }

  // ── Quick Capture lane (docs/34, paypers-style). Any internal staffer holding a bill (the low-risk,
  // company-wide `pr_raise` duty) snaps/uploads it and it lands as a NeedsReview/Mapped DRAFT with the
  // source document stored — never a bill, never a GL posting. A creditor then maps + posts it through
  // the normal EXP-10 pipeline, so the segregation of duties (capturer ≠ poster, EXP-06) is preserved.
  // Functionally identical to the upload channel; the distinct method + permission gate is the control
  // boundary and the narrative anchor. ──
  capture(dto: { file_name?: string; data_url: string }, user: JwtUser) {
    return this.createFromFile(dto, user);
  }

  // The capturer's own submissions. `pr_raise`-only staff cannot see the full AP worklist (that stays
  // procurement/creditors) — only what they themselves captured, scoped to their tenant.
  async listMine(q: { status?: string; limit?: number }, user: JwtUser) {
    const conds: any[] = [eq(apInvoiceIntakes.createdBy, user.username)];
    if (user.tenantId != null) conds.push(eq(apInvoiceIntakes.tenantId, user.tenantId));
    if (q.status) conds.push(eq(apInvoiceIntakes.status, q.status));
    const rows = await this.db.select().from(apInvoiceIntakes).where(and(...conds)).orderBy(desc(apInvoiceIntakes.id)).limit(q.limit ?? 100);
    return { intakes: rows.map((r: any) => this.toDto(r)), count: rows.length };
  }

  private async receive(inp: { fields: any; source: string; rawText: string | null; file?: { name: string; mime: string; dataUrl: string } }, user: JwtUser) {
    const db = this.db;
    const { fields, source } = inp;
    const amount = n(fields.amount);
    const map = await this.mapToPo({ poNo: fields.po_no ?? null, vendorName: fields.vendor_name ?? null, vendorTaxId: fields.vendor_tax_id ?? null, amount });
    // Duplicate-payment guard: the same vendor invoice number scanned twice must not become two bills.
    const dupOf = await this.findDuplicate(fields.invoice_no ?? null, map.vendorName, user.tenantId ?? null, null);
    const status = map.poNo && !dupOf ? 'Mapped' : 'NeedsReview';
    const intakeNo = await this.docNo.nextDaily('AINV');
    // Source document: object store when configured, else keep the data: URL inline (audit trail either way).
    const fileRef = inp.file ? ((await putObject(`ap-intake/${intakeNo}`, inp.file.dataUrl)) ?? inp.file.dataUrl) : null;
    await db.insert(apInvoiceIntakes).values({
      intakeNo, tenantId: user.tenantId ?? null, rawText: inp.rawText,
      vendorId: map.vendorId ?? null, vendorName: map.vendorName, vendorTaxId: fields.vendor_tax_id ?? null,
      invoiceNo: fields.invoice_no ?? null, invoiceDate: fields.invoice_date ?? null,
      amount: amount > 0 ? String(amount) : null, currency: fields.currency ?? 'THB', extractSource: source,
      // Vision line items (already normalized/bounded by doc-ai) — reviewer detail, not match input.
      lines: Array.isArray(fields.lines) && fields.lines.length ? fields.lines : null,
      poNo: map.poNo, mapMethod: map.method, mapConfidence: String(map.confidence), candidates: map.candidates,
      dupOf, fileName: inp.file?.name ?? null, fileMime: inp.file?.mime ?? null, fileRef, status, createdBy: user.username,
    });
    await this.statusLog.log('AINV', intakeNo, '', status, user.username, map.poNo ? `Auto-mapped ${map.poNo} (${map.method})` : 'Needs review');
    return this.get(intakeNo);
  }

  // ── One-shot automation (creditors): extract → map → post bill → 3-way match in a single call.
  // Falls back to a NeedsReview intake (no bill, no GL) when the mapper is not confident or a duplicate
  // is suspected — automation never books an ambiguous document. ──
  async createAuto(text: string, user: JwtUser) {
    return this.autoFinish(await this.create(text, user), user);
  }
  async createFileAuto(dto: { file_name?: string; data_url: string }, user: JwtUser) {
    return this.autoFinish(await this.createFromFile(dto, user), user);
  }
  private async autoFinish(created: any, user: JwtUser) {
    if (created.status !== 'Mapped') return { ...created, auto_posted: false };
    const posted = await this.post(created.intake_no, {}, user);
    return { ...posted, auto_posted: true };
  }

  // The stored source document. Inline fallback returns the data: URL; an object-store ref returns its URL.
  async getFile(intakeNo: string) {
    const it = await this.load(intakeNo);
    if (!it.fileRef) throw new NotFoundException({ code: 'NO_FILE', message: 'Intake has no source document', messageTh: 'เอกสารรับเข้านี้ไม่มีไฟล์แนบ' });
    const stored = isObjectRef(it.fileRef);
    return { intake_no: it.intakeNo, file_name: it.fileName, mime: it.fileMime, url: stored ? objectUrl(it.fileRef) : null, data_url: stored ? null : it.fileRef };
  }

  // ── Manual (re)map from the review worklist. On an already-posted intake this re-runs the match
  // against the corrected PO. ──
  async map(intakeNo: string, poNo: string, user: JwtUser) {
    const db = this.db;
    const it = await this.load(intakeNo);
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'PO_NOT_FOUND', message: `PO ${poNo} not found`, messageTh: 'ไม่พบ PO' });
    if (!(MAPPABLE_PO_STATUS as readonly string[]).includes(String(po.status))) {
      throw new BadRequestException({ code: 'PO_NOT_APPROVED', message: `PO ${poNo} is ${po.status} — map to an approved PO`, messageTh: 'PO ยังไม่อนุมัติ' });
    }
    const vals: any = { poNo, mapMethod: 'manual', mapConfidence: '100', vendorId: po.vendorId ?? it.vendorId ?? null };
    let matchRes: any = null;
    if (it.status === 'Posted' && it.txnNo) {
      // Re-match against the corrected PO — same line-level escalation rule as post().
      matchRes = await this.matchSvc.match(it.txnNo, poNo, await this.visionMatchLines(it.lines, poNo), user);
      vals.matchStatus = matchRes.match_status; vals.payable = matchRes.payable;
    } else if (it.status === 'NeedsReview') vals.status = 'Mapped';
    await db.update(apInvoiceIntakes).set(vals).where(eq(apInvoiceIntakes.id, it.id));
    await this.statusLog.log('AINV', intakeNo, it.status, vals.status ?? it.status, user.username, `Mapped ${poNo} (manual)`);
    return this.get(intakeNo);
  }

  // ── Step 2 (creditors): book the AP bill and auto-run the 3-way match. Idempotent — re-posting
  // returns the existing bill (createApTxn dedups on the intake-scoped idempotency key). A suspected
  // duplicate is refused unless explicitly forced with a reason-bearing flag. ──
  async post(intakeNo: string, opts: { po_no?: string; allow_duplicate?: boolean }, user: JwtUser) {
    const db = this.db;
    const it = await this.load(intakeNo);
    if (it.status === 'Posted') return this.get(intakeNo);
    if (!(n(it.amount) > 0)) throw new BadRequestException({ code: 'INTAKE_AMOUNT_REQUIRED', message: 'No amount extracted — correct the document before posting', messageTh: 'ไม่พบจำนวนเงินจากเอกสาร' });
    const poNo = opts.po_no ?? it.poNo ?? null;
    const dupOf = it.dupOf ?? (await this.findDuplicate(it.invoiceNo, it.vendorName, it.tenantId ?? null, it.intakeNo));
    if (dupOf && !opts.allow_duplicate) {
      throw new ConflictException({ code: 'DUPLICATE_INVOICE', message: `Invoice ${it.invoiceNo} already booked via ${dupOf}`, messageTh: `ใบแจ้งหนี้เลขนี้ถูกบันทึกแล้ว (${dupOf})`, dup_of: dupOf });
    }
    // The extracted document currency books onto the bill (C1 parity with POs/GRs) so a scanned USD
    // invoice feeds the EXP-06 multi-currency statement in its own units. The booked rate comes from the
    // latest APPROVED fx_rates row at the invoice date (the ledger's canonical rateAsOf rule); with no
    // approved rate it books at 1 — same manual-default behavior as PO creation.
    const currency = (it.currency ?? 'THB').trim().toUpperCase() || 'THB';
    const bill = await this.finance.createApTxn({
      vendor_id: it.vendorId != null ? Number(it.vendorId) : undefined, vendor_name: it.vendorName ?? undefined,
      txn_type: 'Invoice', invoice_no: it.invoiceNo ?? undefined, invoice_date: it.invoiceDate ?? undefined,
      amount: n(it.amount), tenant_id: it.tenantId ?? undefined, idempotency_key: `apintake:${it.intakeNo}`,
      remarks: `AP intake ${it.intakeNo}${poNo ? ` → ${poNo}` : ''}`,
      currency, fx_rate: await this.bookedFxRate(currency, it.invoiceDate ?? ymd()),
    }, user);
    // PO-based → run the 3-way match now. Vision lines ESCALATE it to LINE-level when every extracted
    // line maps unambiguously onto the PO's own lines (per-line qty/price tolerance verdicts, EXP-01);
    // any unmapped/ambiguous line falls the whole set back to today's header-level amount match — the
    // mapper can tighten precision but never loosen the existing verdict path.
    // Non-PO (utilities/services) posts unmatched and stays payable per the fail-open EXP-01 policy.
    let matchRes: any = null;
    let matchLines: MappedMatchLine[] | undefined;
    if (poNo) {
      matchLines = await this.visionMatchLines(it.lines, poNo);
      matchRes = await this.matchSvc.match(bill.txn_no, poNo, matchLines, user);
    }
    await db.update(apInvoiceIntakes).set({
      status: 'Posted', txnNo: bill.txn_no, poNo, matchStatus: matchRes?.match_status ?? null,
      payable: matchRes ? matchRes.payable : true, postedBy: user.username, postedAt: new Date(),
    }).where(eq(apInvoiceIntakes.id, it.id));
    await this.statusLog.log('AINV', intakeNo, it.status, 'Posted', user.username, `Bill ${bill.txn_no}${matchRes ? ` match=${matchRes.match_status}${matchLines ? ' (line-level)' : ''}` : ' (non-PO)'}`);
    return this.get(intakeNo);
  }

  async get(intakeNo: string) {
    const it = await this.load(intakeNo);
    return this.toDto(it);
  }

  async list(q: { status?: string; limit?: number }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(apInvoiceIntakes.tenantId, user.tenantId));
    if (q.status) conds.push(eq(apInvoiceIntakes.status, q.status));
    const rows = await db.select().from(apInvoiceIntakes).where(conds.length ? and(...conds) : undefined).orderBy(desc(apInvoiceIntakes.id)).limit(q.limit ?? 100);
    return { intakes: rows.map((r: any) => this.toDto(r)), count: rows.length };
  }

  // ── PO auto-mapper. Order of trust: explicit PO number in the document → vendor tax-id + amount →
  // vendor-name + amount. Only an unambiguous winner is auto-mapped; ties and weak scores go to review. ──
  private async mapToPo(inp: { poNo: string | null; vendorName: string | null; vendorTaxId: string | null; amount: number }) {
    const db = this.db;
    if (inp.poNo) {
      const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, inp.poNo.trim())).limit(1);
      if (po && (MAPPABLE_PO_STATUS as readonly string[]).includes(String(po.status))) {
        return { poNo: po.poNo, method: 'po_number', confidence: 100, vendorId: po.vendorId != null ? Number(po.vendorId) : null, vendorName: inp.vendorName ?? po.vendorName ?? null, candidates: [] as PoCandidate[] };
      }
    }
    // Vendor by 13-digit tax id. The master tax_id is encrypted at rest (random-IV ciphertext never
    // collides in SQL), so the primary lookup is the tax_id_bidx BLIND INDEX (0433, digits-only
    // blindIndex) — every hit re-verified against the decrypted value (a vendor whose tax id changed
    // leaves a stale index behind; verification means it can only miss, never mis-map). A miss falls
    // back to the bounded decrypt-and-scan (ghost-vendor-detector pattern), which SELF-HEALS the index
    // best-effort — so legacy rows and every writer (bulk import, MDM-01 change, merge) converge onto
    // the indexed path without a decrypting backfill.
    let vendorId: number | null = null; let vendorName = inp.vendorName;
    if (inp.vendorTaxId) {
      const want = inp.vendorTaxId.replace(/\D/g, '');
      const bidx = blindIndex(want);
      let hit: { id: unknown; name: string | null; taxId: string | null } | undefined;
      if (bidx) {
        const [byIdx] = await db.select({ id: vendors.id, name: vendors.name, taxId: vendors.taxId }).from(vendors)
          .where(and(eq(vendors.active, true), eq(vendors.taxIdBidx, bidx))).limit(1);
        if (byIdx && String(byIdx.taxId ?? '').replace(/\D/g, '') === want) hit = byIdx;
      }
      if (!hit) {
        const vrows = await db.select({ id: vendors.id, name: vendors.name, taxId: vendors.taxId }).from(vendors).where(eq(vendors.active, true)).limit(500);
        hit = vrows.find((v: any) => String(v.taxId ?? '').replace(/\D/g, '') === want);
        if (hit && bidx) {
          try { await db.update(vendors).set({ taxIdBidx: bidx }).where(eq(vendors.id, Number(hit.id))); } catch { /* index heal is best-effort */ }
        }
      }
      if (hit) { vendorId = Number(hit.id); vendorName = hit.name; }
    }
    const open = await db.select().from(purchaseOrders).where(inArray(purchaseOrders.status, [...MAPPABLE_PO_STATUS])).orderBy(desc(purchaseOrders.id)).limit(200);
    const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
    const iv = norm(vendorName);
    const candidates: PoCandidate[] = open.map((po: any) => {
      const total = n(po.totalAmount);
      const pv = norm(po.vendorName);
      const vendorHit = vendorId != null && po.vendorId != null ? Number(po.vendorId) === vendorId : Boolean(iv && pv && (iv.includes(pv) || pv.includes(iv)));
      let score = vendorHit ? 60 : 0;
      if (inp.amount > 0 && total > 0) {
        const diff = Math.abs(inp.amount - total) / total;
        score += diff <= 0.02 ? 40 : diff <= 0.10 ? 25 : diff <= 0.25 ? 10 : 0; // ≤10% band absorbs a VAT-inclusive total vs an ex-VAT PO
      }
      return { po_no: po.poNo, vendor_name: po.vendorName ?? null, total_amount: total, score };
    }).filter((c) => c.score >= 40).sort((a, b) => b.score - a.score).slice(0, 5); // vendor hit or near-exact amount — loose amount-only proximity is noise
    const best = candidates[0];
    if (best && best.score >= AUTO_MAP_MIN && (candidates.length === 1 || best.score - candidates[1]!.score >= RUNNER_UP_GAP)) {
      return { poNo: best.po_no, method: vendorId != null ? 'vendor_tax_id' : 'vendor_amount', confidence: best.score, vendorId, vendorName, candidates };
    }
    return { poNo: null, method: null, confidence: best?.score ?? 0, vendorId, vendorName, candidates };
  }

  // Duplicate check: another intake (any status) or an existing AP bill already carrying this vendor
  // invoice number in the same tenant. Returns the earlier document number, or null.
  private async findDuplicate(invoiceNo: string | null, vendorName: string | null, tenantId: number | null, excludeIntakeNo: string | null) {
    if (!invoiceNo) return null;
    const db = this.db;
    const iConds: any[] = [eq(apInvoiceIntakes.invoiceNo, invoiceNo)];
    if (tenantId != null) iConds.push(eq(apInvoiceIntakes.tenantId, tenantId));
    if (excludeIntakeNo) iConds.push(ne(apInvoiceIntakes.intakeNo, excludeIntakeNo));
    const [ex] = await db.select({ intakeNo: apInvoiceIntakes.intakeNo, vendorName: apInvoiceIntakes.vendorName }).from(apInvoiceIntakes).where(and(...iConds)).limit(1);
    if (ex && this.sameVendor(ex.vendorName, vendorName)) return ex.intakeNo;
    const tConds: any[] = [eq(apTransactions.invoiceNo, invoiceNo)];
    if (tenantId != null) tConds.push(eq(apTransactions.tenantId, tenantId));
    const [tx] = await db.select({ txnNo: apTransactions.txnNo, vendorName: apTransactions.vendorName }).from(apTransactions).where(and(...tConds)).limit(1);
    if (tx && this.sameVendor(tx.vendorName, vendorName)) return tx.txnNo;
    return null;
  }
  private sameVendor(a: string | null, b: string | null) {
    const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
    const x = norm(a), y = norm(b);
    return !x || !y || x.includes(y) || y.includes(x); // unknown vendor on either side → treat same invoice no as a duplicate
  }

  // Vision lines → 3-way-match line input, against the mapped PO's own lines (small candidate set).
  // Returns undefined (→ header-level match, today's behavior) unless EVERY line maps unambiguously —
  // see ap-intake.match-lines.ts for the identity rules.
  private async visionMatchLines(lines: unknown, poNo: string): Promise<MappedMatchLine[] | undefined> {
    if (!Array.isArray(lines) || lines.length === 0) return undefined;
    const [po] = await this.db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) return undefined;
    const pls = await this.db.select({ itemId: poItems.itemId, itemDescription: poItems.itemDescription }).from(poItems).where(eq(poItems.poId, po.id));
    // The jsonb column arrives as unknown; the Array.isArray guard above plus doc-ai's normalization
    // make this a safe narrow (the mapper re-validates qty/price per line anyway).
    return mapVisionLinesToPo(lines as VisionLine[], pls.map((p) => ({ item_id: String(p.itemId), item_description: p.itemDescription ?? null })));
  }

  // Booked rate for a foreign-currency bill: latest APPROVED fx_rates row with rate_date <= asOf (the
  // canonical rateAsOf rule from fx.service/fx-reval.service). THB ⇒ 1; no approved rate ⇒ 1 (parity with
  // PO creation's manual-default rate — never blocks the posting).
  private async bookedFxRate(currency: string, asOf: string): Promise<number> {
    if (currency === 'THB') return 1;
    const [r] = await this.db.select().from(fxRates)
      .where(and(eq(fxRates.currency, currency), eq(fxRates.status, 'Approved'), sql`${fxRates.rateDate} <= ${asOf}`))
      .orderBy(desc(fxRates.rateDate), desc(fxRates.id)).limit(1);
    const rate = r ? n(r.rate) : 0;
    return rate > 0 ? rate : 1;
  }

  private async load(intakeNo: string) {
    const [it] = await this.db.select().from(apInvoiceIntakes).where(eq(apInvoiceIntakes.intakeNo, intakeNo)).limit(1);
    if (!it) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Intake not found', messageTh: 'ไม่พบเอกสารรับเข้า' });
    return it;
  }

  private toDto(r: any) {
    return {
      intake_no: r.intakeNo, status: r.status, extract_source: r.extractSource,
      vendor_id: r.vendorId != null ? Number(r.vendorId) : null, vendor_name: r.vendorName, vendor_tax_id: r.vendorTaxId,
      invoice_no: r.invoiceNo, invoice_date: r.invoiceDate, amount: r.amount != null ? n(r.amount) : null, currency: r.currency,
      po_no: r.poNo, map_method: r.mapMethod, map_confidence: n(r.mapConfidence), candidates: r.candidates ?? [], lines: r.lines ?? [],
      dup_of: r.dupOf, file_name: r.fileName, file_mime: r.fileMime, has_file: r.fileRef != null,
      txn_no: r.txnNo, match_status: r.matchStatus, payable: r.payable,
      created_by: r.createdBy, created_at: r.createdAt, posted_by: r.postedBy, posted_at: r.postedAt,
    };
  }
}
