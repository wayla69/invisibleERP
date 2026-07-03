import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq, and, ne, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apInvoiceIntakes, apTransactions, purchaseOrders, vendors } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { DocAiService } from '../doc-ai/doc-ai.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { FinanceService } from '../finance/finance.service';
import { putObject, objectUrl, isObjectRef } from '../../common/object-storage';

// AP invoice intake (EXP-10): scanned/pasted vendor invoice → doc-ai extraction → PO auto-map →
// post AP bill → automated 3-way match. Automates the path TO payment-ready only — the disbursement
// itself stays behind the EXP-01 match gate and the AP-PAY maker-checker (EXP-06). Anything the mapper
// cannot resolve unambiguously queues as NeedsReview for a human instead of guessing.
const AUTO_MAP_MIN = 85;   // vendor + amount must both agree before we map without a human
const RUNNER_UP_GAP = 15;  // and no near-tie with the second-best PO

// Upload channel: accepted document types + data-URL size caps (chars ≈ bytes × 4/3). The image cap
// stays under Claude's 5 MB per-image limit; the PDF cap keeps an inline-in-DB fallback row sane.
const UPLOAD_MIME: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const MAX_DATAURL: Record<string, number> = { 'application/pdf': 12_000_000 }; // default (images) below
const MAX_DATAURL_DEFAULT = 6_500_000;

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
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dto.data_url ?? '');
    if (!m) throw new BadRequestException({ code: 'BAD_DATA_URL', message: 'data_url must be a base64 data: URL', messageTh: 'รูปแบบไฟล์ไม่ถูกต้อง' });
    const mime = m[1]!.toLowerCase();
    if (!UPLOAD_MIME.includes(mime)) {
      throw new BadRequestException({ code: 'UNSUPPORTED_FILE_TYPE', message: `Unsupported type ${mime} — use PNG/JPEG/WebP or PDF`, messageTh: 'รองรับเฉพาะรูปภาพ (PNG/JPEG/WebP) และ PDF' });
    }
    if (dto.data_url.length > (MAX_DATAURL[mime] ?? MAX_DATAURL_DEFAULT)) {
      throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'File too large', messageTh: 'ไฟล์ใหญ่เกินไป' });
    }
    const ext = await this.docAi.extractInvoiceDocument({ media_type: mime, data: m[2]! }, user);
    return this.receive({
      fields: ext.fields, source: ext.source, rawText: ext.text || null,
      file: { name: (dto.file_name ?? 'document').slice(0, 200), mime, dataUrl: dto.data_url },
    }, user);
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
      matchRes = await this.matchSvc.match(it.txnNo, poNo, undefined, user);
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
    const bill = await this.finance.createApTxn({
      vendor_id: it.vendorId != null ? Number(it.vendorId) : undefined, vendor_name: it.vendorName ?? undefined,
      txn_type: 'Invoice', invoice_no: it.invoiceNo ?? undefined, invoice_date: it.invoiceDate ?? undefined,
      amount: n(it.amount), tenant_id: it.tenantId ?? undefined, idempotency_key: `apintake:${it.intakeNo}`,
      remarks: `AP intake ${it.intakeNo}${poNo ? ` → ${poNo}` : ''}`,
    }, user);
    // PO-based → run the 3-way match now (header amount match when the scan has no line detail).
    // Non-PO (utilities/services) posts unmatched and stays payable per the fail-open EXP-01 policy.
    let matchRes: any = null;
    if (poNo) matchRes = await this.matchSvc.match(bill.txn_no, poNo, undefined, user);
    await db.update(apInvoiceIntakes).set({
      status: 'Posted', txnNo: bill.txn_no, poNo, matchStatus: matchRes?.match_status ?? null,
      payable: matchRes ? matchRes.payable : true, postedBy: user.username, postedAt: new Date(),
    }).where(eq(apInvoiceIntakes.id, it.id));
    await this.statusLog.log('AINV', intakeNo, it.status, 'Posted', user.username, `Bill ${bill.txn_no}${matchRes ? ` match=${matchRes.match_status}` : ' (non-PO)'}`);
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
    // Vendor by 13-digit tax id — the master tax_id is encrypted at rest, so compare decrypted values in
    // app code (same pattern as the ghost-vendor detector; ciphertext never collides in SQL).
    let vendorId: number | null = null; let vendorName = inp.vendorName;
    if (inp.vendorTaxId) {
      const vrows = await db.select({ id: vendors.id, name: vendors.name, taxId: vendors.taxId }).from(vendors).where(eq(vendors.active, true)).limit(500);
      const want = inp.vendorTaxId.replace(/\D/g, '');
      const hit = vrows.find((v: any) => String(v.taxId ?? '').replace(/\D/g, '') === want);
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
      po_no: r.poNo, map_method: r.mapMethod, map_confidence: n(r.mapConfidence), candidates: r.candidates ?? [],
      dup_of: r.dupOf, file_name: r.fileName, file_mime: r.fileMime, has_file: r.fileRef != null,
      txn_no: r.txnNo, match_status: r.matchStatus, payable: r.payable,
      created_by: r.createdBy, created_at: r.createdAt, posted_by: r.postedBy, posted_at: r.postedAt,
    };
  }
}
