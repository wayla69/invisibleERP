import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { purchaseOrders, poItems, goodsReceipts, vendors, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { WorkflowService } from '../workflow/workflow.service';
import { WebhookService } from '../platform/webhook.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { DocumentTemplatesService } from '../document-templates/document-templates.service';
import { normalizeA4Template } from '../../common/a4-template';
import { ymd } from '../../database/queries';
import { n, type CreatePoDto } from './procurement.shared';
import type { JwtUser } from '../../common/decorators';

// PO sub-service (docs/38 §3 procurement decomposition, PR-3): purchase orders — createPo (supplier
// screening + M0/M2 project dimension + M1/PROJ-12 BoQ-line encumbrance + approval-workflow routing),
// approvePo (engine-first, legacy Admin fallback), cancelPo (GR guard + commitment release) and the
// printable PO — moved VERBATIM. A PLAIN class constructed in the ProcurementService ctor BODY (the
// goldenmaster/writeflow harnesses construct the facade positionally with 3 args). The three shared
// facade helpers (Phase-16 supplier screening, project-code resolution, D2 LINE notify) are injected
// as callback ports so the PR/vendor surfaces stay on the facade.
export class ProcurementPoService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly assertSupplierAllowed: (vendorId: number | null, vendorName: string | null) => Promise<void>,
    private readonly resolveProjectId: (code?: string) => Promise<number | null>,
    private readonly notifyRequesters: (poNo: string, message: string) => Promise<void>,
    private readonly workflow?: WorkflowService,
    private readonly webhooks?: WebhookService,
    private readonly commitments?: CommitmentsService,
    private readonly docTemplates?: DocumentTemplatesService,
  ) {}

  // ── PO ──────────────────────────────────────────────────────────────
  async createPo(dto: CreatePoDto, user: JwtUser) {
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    let vendorId = dto.vendor_id ?? null;
    let vendorName = dto.vendor_name ?? null;
    if (!vendorId && vendorName) {
      const [v] = await db.select().from(vendors).where(eq(vendors.name, vendorName)).limit(1);
      vendorId = v?.id ?? null;
    } else if (vendorId && !vendorName) {
      const [v] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
      vendorName = v?.name ?? null;
    }
    await this.assertSupplierAllowed(vendorId, vendorName); // Phase 16 — blocklisted/unapproved vendor → 422
    // M0/M2 — project dimension (nullable). project_id may be passed directly (PMR auto-draft) or resolved from a code.
    const projectId = dto.project_id ?? await this.resolveProjectId(dto.project_code);
    const isDraft = dto.draft === true; // M2 — PMR auto-draft opens as Draft (skips the approval workflow)
    const total = dto.items.reduce((a, it) => a + n(it.order_qty) * n(it.unit_price), 0);
    const poNo = await this.docNo.nextDaily('PO');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseOrders).values({
        poNo, poDate: ymd(), vendorId, vendorName, status: isDraft ? 'Draft' : 'Pending', totalAmount: String(total),
        createdBy: user.username, expectedDate: dto.expected_date ?? null, remarks: dto.remarks ?? null,
        currency: dto.currency ?? 'THB', fxRate: String(dto.fx_rate ?? 1), projectId, tenantId: user.tenantId ?? null,
      }).returning({ id: purchaseOrders.id });
      await tx.insert(poItems).values(dto.items.map((it) => ({
        poId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        orderQty: String(n(it.order_qty)), unitPrice: String(n(it.unit_price)), uom: it.uom ?? null,
        amount: String(n(it.order_qty) * n(it.unit_price)), receivedQty: '0', isCapital: it.is_capital === true, status: 'Open',
        projectId, boqLineId: it.boq_line_id ?? null, tenantId: user.tenantId ?? null,
      })));
      // M1 (PROJ-12) — a project PO line tagged to a BoQ line ENCUMBERS that line's budget. reserve() locks the
      // BoQ line (FOR UPDATE) and throws BUDGET_EXCEEDED if the line's open+consumed commitments would exceed
      // its budget — inside this tx, so an over-budget line rolls the whole PO back (nothing is created).
      if (this.commitments && projectId != null) {
        for (const it of dto.items) {
          if (it.boq_line_id == null) continue;
          await this.commitments.reserve(tx, {
            projectId, boqLineId: it.boq_line_id, amount: n(it.order_qty) * n(it.unit_price), qty: n(it.order_qty),
            sourceDocType: 'PO', sourceDocNo: poNo, createdBy: user.username, tenantId: user.tenantId ?? null,
            allowOver: dto.authorized_over_budget === true, // M2 — an approved over-budget PMR authorises the overage
          });
        }
      }
    });
    // A Draft PO (PMR auto-draft) is not yet committed — it does NOT enter the approval workflow; procurement
    // reviews and submits it. A normal PO opens Pending and routes into the approval engine.
    await this.statusLog.log('PO', poNo, '', isDraft ? 'Draft' : 'Pending', user.username);
    if (!isDraft) await this.workflow?.start({ docType: 'PO', docNo: poNo, amount: total, createdBy: user.username, tenantId: user.tenantId ?? null, context: { vendor: vendorName ?? '' } });
    return { po_no: poNo, status: isDraft ? 'Draft' : 'Pending', total_amount: total };
  }

  async approvePo(poNo: string, approve: boolean, reason: string | undefined, user: JwtUser, budgetOpts?: { confirmOverBudget?: boolean; overrideBudget?: boolean; overrideReason?: string }) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    // FIN-3 (BUD-02) — budgetary-control gate: when the tenant's budget-control policy is on
    // (advise|warn|block), an APPROVE decision is checked against the available budget (approved budget YTD −
    // GL actuals − open commitments, per resolved budget account). glGate returns null when the policy is
    // 'off' (the default — response byte-identical to pre-FIN-3) and throws BUDGET_EXCEEDED /
    // BUDGET_CONFIRM_REQUIRED per policy BEFORE any state changes. Project/BoQ-tagged lines are excluded
    // (PROJ-12/13 already encumber them); is_capital lines are excluded (CAPEX ≠ opex budget).
    let budgetGate: Awaited<ReturnType<CommitmentsService['glGate']>> = null;
    if (approve && this.commitments && po.status !== 'Approved') {
      budgetGate = await this.commitments.glGateForDoc('PO', poNo, {
        tenantId: user.tenantId ?? null, user,
        confirm: budgetOpts?.confirmOverBudget, override: budgetOpts?.overrideBudget, overrideReason: budgetOpts?.overrideReason,
      });
    }
    // route through the approval engine when a workflow is configured (maker-checker + multi-level + SoD +
    // dimension routing all enforced there); otherwise fall back to the legacy Admin-only flip.
    const inst = this.workflow ? await this.workflow.pendingInstanceFor('PO', poNo) : null;
    let newStatus: 'Pending' | 'Approved' | 'Cancelled';
    if (inst) {
      await this.workflow!.act(Number(inst.id), { decision: approve ? 'approve' : 'reject' }, user);
      const cleared = await this.workflow!.canTransition('PO', poNo);
      newStatus = approve ? (cleared ? 'Approved' : 'Pending') : 'Cancelled';
      await db.update(purchaseOrders).set({ status: newStatus, approvedBy: user.username, approvedAt: new Date(), remarks: approve ? po.remarks : `Rejected: ${reason ?? ''}` }).where(eq(purchaseOrders.id, po.id));
      if (newStatus !== po.status) await this.statusLog.log('PO', poNo, po.status ?? '', newStatus, user.username);
    } else {
      if (user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin only', messageTh: 'เฉพาะผู้ดูแล' });
      newStatus = approve ? 'Approved' : 'Cancelled';
      await db.update(purchaseOrders).set({
        status: newStatus, approvedBy: user.username, approvedAt: new Date(),
        remarks: approve ? po.remarks : `Rejected: ${reason ?? ''}`,
      }).where(eq(purchaseOrders.id, po.id));
      await this.statusLog.log('PO', poNo, po.status ?? '', newStatus, user.username);
    }
    // BUD-02 — the final approval RECORDS the commitment (encumbers the budget); an authorised over-budget
    // approval is audited on the commitment row (override_by/override_reason) + the doc status log.
    if (budgetGate && newStatus === 'Approved') {
      await this.commitments!.glReserve(db, budgetGate, { docType: 'PO', docNo: poNo, tenantId: user.tenantId ?? null, user });
      if (budgetGate.overridden) await this.statusLog.log('PO', poNo, 'Pending', 'Approved', user.username, `BUDGET_OVERRIDE (BUD-02): ${budgetGate.override_reason}`);
    }
    await this.emitPo(newStatus, poNo, po, reason, user);
    return { po_no: poNo, status: newStatus, ...(budgetGate ? { budget: { policy: budgetGate.policy, exceeded: budgetGate.exceeded, overridden: budgetGate.overridden, checks: budgetGate.checks } } : {}) };
  }

  // Fan out the PO approval/rejection to outbound webhooks (best-effort; only on a terminal decision).
  private async emitPo(newStatus: string, poNo: string, po: any, reason: string | undefined, user: JwtUser) {
    const event = newStatus === 'Approved' ? 'po.approved' : (newStatus === 'Cancelled' ? 'po.rejected' : null);
    if (!event) return;
    await this.webhooks?.emit(event, { po_no: poNo, vendor: po.vendorName ?? po.vendorCode ?? null, total_amount: Number(po.total ?? 0), status: newStatus, reason: reason ?? null, decided_by: user.username }, user);
    // D2 — close the loop: tell the requester(s) of any PR linked to this PO that it's approved / rejected.
    if (newStatus === 'Approved') await this.notifyRequesters(poNo, `✅ ใบสั่งซื้อ ${poNo} (จากคำขอซื้อของคุณ) อนุมัติแล้ว — กำลังสั่งซื้อ`);
    else if (newStatus === 'Cancelled') await this.notifyRequesters(poNo, `❌ ใบสั่งซื้อ ${poNo} (จากคำขอซื้อของคุณ) ถูกยกเลิก${reason ? ` — ${reason}` : ''}`);
  }

  async cancelPo(poNo: string, reason: string, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    // parity: ถ้ามี GR แล้วและไม่ใช่ Admin → ปิดไม่ได้
    const [gr] = await db.select({ id: goodsReceipts.id }).from(goodsReceipts).where(eq(goodsReceipts.poNo, poNo)).limit(1);
    if (gr && user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'PO has GR — must close via Admin', messageTh: 'มีการรับของแล้ว ต้องปิดผ่าน Admin' });
    if (!reason) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Cancel reason required', messageTh: 'ต้องระบุเหตุผล' });
    await db.update(purchaseOrders).set({ status: 'Cancelled', remarks: reason }).where(eq(purchaseOrders.id, po.id));
    await this.statusLog.log('PO', poNo, po.status ?? '', 'Cancelled', user.username, reason);
    // M1 (PROJ-12) — a cancelled PO releases the BoQ-line budget it encumbered (frees it for other draws).
    if (this.commitments) await this.commitments.release(db, 'PO', poNo);
    // FIN-3 (BUD-02) — likewise the GL-budget commitment (no-op when the gate was off at approval).
    if (this.commitments) await this.commitments.glRelease(db, 'PO', poNo);
    return { po_no: poNo, status: 'Cancelled' };
  }

  // Assemble the printable PO (header + lines + supplier + our-company/buyer block) for the PDF renderer.
  // The buyer block is the caller's tenant (the company raising the PO); the vendor block is the supplier.
  // VAT is shown as an ESTIMATE at the buyer tenant's VAT rate only when the tenant is VAT-registered — a PO
  // is a commitment, not a tax document (the ใบกำกับภาษี is issued by the supplier on delivery), so the row
  // is suppressed for non-VAT buyers rather than fabricating tax.
  async getPoForPrint(poNo: string, user: JwtUser): Promise<import('./po-pdf.service').PoPrintData> {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    const lineRows = await db.select().from(poItems).where(eq(poItems.poId, Number(po.id))).orderBy(asc(poItems.id));
    const vendorRow = po.vendorId ? (await db.select().from(vendors).where(eq(vendors.id, Number(po.vendorId))).limit(1))[0] : null;

    // Buyer = the caller's tenant (our company). HQ/bypass callers may have no tenantId → generic fallback.
    let t: any = null;
    if (user.tenantId != null) [t] = await db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1);
    const buyerAddress = t
      ? [t.addressLine1, t.addressLine2, t.subDistrict, t.district, t.province, t.postalCode].filter(Boolean).join(' ')
      : '';

    const lines = lineRows.map((l: any) => ({
      item_id: l.itemId ?? null, description: l.itemDescription ?? null, qty: n(l.orderQty), uom: l.uom ?? null,
      unit_price: n(l.unitPrice), amount: n(l.amount ?? n(l.orderQty) * n(l.unitPrice)),
    }));
    const subtotal = lines.reduce((a, l) => a + l.amount, 0);
    const vatRate = t?.vatRegistered ? n(t.vatRate ?? 0.07) : 0;
    const vatAmount = Math.round(subtotal * vatRate * 100) / 100;
    // Resolve the tenant's active PO template (presentation only); a lookup failure never blocks the doc.
    let template = normalizeA4Template({});
    try { if (this.docTemplates) template = normalizeA4Template(await this.docTemplates.resolveActive('purchase_order')); } catch { /* keep default */ }

    return {
      po_no: po.poNo, po_date: po.poDate ?? null, expected_date: po.expectedDate ?? null, status: String(po.status ?? ''),
      remarks: po.remarks ?? null, currency: po.currency ?? 'THB', created_by: po.createdBy ?? null,
      approved_by: po.approvedBy ?? null, approved_at: po.approvedAt ? new Date(po.approvedAt).toISOString() : null,
      buyer: {
        name: t?.legalName || t?.name || 'บริษัทของฉัน', address: buyerAddress || (t?.address ?? '-'),
        tax_id: t?.taxId ?? null, branch_label: t?.branchLabelTh ?? 'สำนักงานใหญ่', phone: t?.phone ?? null,
        logo_url: t?.logoUrl ?? null,
      },
      vendor: {
        code: vendorRow?.vendorCode ?? null, name: vendorRow?.name ?? po.vendorName ?? '-', address: vendorRow?.address ?? null, tax_id: vendorRow?.taxId ?? null,
        contact: vendorRow?.contact ?? null, phone: vendorRow?.phone ?? null, payment_terms: vendorRow?.paymentTerms ?? null,
      },
      lines, subtotal, vat_rate: vatRate, vat_amount: vatAmount, grand_total: Math.round((subtotal + vatAmount) * 100) / 100, template,
    };
  }
}
