import { BadRequestException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { purchaseRequests, prItems, items, vendors } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { WorkflowService } from '../workflow/workflow.service';
import { LineNotifyService } from '../messaging/line-notify.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { ymd } from '../../database/queries';
import { n, type CreatePrDto, type CreatePoDto, type ConvLine } from './procurement.shared';
import type { JwtUser } from '../../common/decorators';

// PR (requisition) sub-service (docs/38 §3 procurement decomposition, PR-4 — the final prescribed cut):
// createPr (M0 project dimension + workflow routing), approvePr (engine-first, legacy Admin fallback),
// cancelPr (0228 own-doc withdraw), listPrs (requester/approver scoping + item-name backfill), one-tap
// reorderPr, and convertPrToPo (legacy single-PO + split multi-supplier fan-out) — moved VERBATIM. A
// PLAIN class constructed in the ProcurementService ctor BODY (the goldenmaster/writeflow harnesses
// construct the facade positionally with 3 args). Facade helpers arrive as callback ports: project-code
// resolution, the low-stock read (inventory surface), the preferred-vendor learner, and createPo itself
// (so PR→PO conversion rides the SAME screened/encumbered/workflow path as a direct PO).
export class ProcurementPrService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly resolveProjectId: (code?: string) => Promise<number | null>,
    private readonly lowStock: (user: JwtUser) => Promise<{ items: any[] }>,
    private readonly setPreferredVendor: (itemId: string, dto: { vendor_id: number; unit_price?: number; uom?: string; currency?: string; remove?: boolean }, user: JwtUser) => Promise<unknown>,
    private readonly createPo: (dto: CreatePoDto, user: JwtUser) => Promise<{ po_no: string; status: string; total_amount: number }>,
    private readonly workflow?: WorkflowService,
    private readonly lineNotify?: LineNotifyService,
    private readonly commitments?: CommitmentsService, // FIN-3 (BUD-02) — GL-budget gate + PR encumbrance
  ) {}

  // ── PR ──────────────────────────────────────────────────────────────
  async createPr(dto: CreatePrDto, user: JwtUser) {
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const projectId = await this.resolveProjectId(dto.project_code); // M0 — project dimension (nullable)
    const prNo = await this.docNo.nextDaily('PR');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseRequests).values({
        prNo, prDate: ymd(), requestedBy: user.username, status: 'Pending', remarks: dto.remarks ?? null, priority: dto.priority ?? 'Normal', projectId, tenantId: user.tenantId ?? null,
      }).returning({ id: purchaseRequests.id });
      await tx.insert(prItems).values(dto.items.map((it) => ({
        prId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        requestQty: String(n(it.request_qty)), uom: it.uom ?? null, requiredDate: it.required_date ?? null,
        reason: it.reason ?? null, status: 'Open', boqLineId: it.boq_line_id ?? null, tenantId: user.tenantId ?? null,
      })));
    });
    await this.statusLog.log('PR', prNo, '', 'Pending', user.username);
    // route into the approval engine (no active PR definition → autoApproved, legacy passthrough)
    await this.workflow?.start({ docType: 'PR', docNo: prNo, amount: n(dto.amount), createdBy: user.username, tenantId: user.tenantId ?? null });
    return { pr_no: prNo, status: 'Pending', lines: dto.items.length };
  }

  async approvePr(prNo: string, approve: boolean, user: JwtUser, budgetOpts?: { confirmOverBudget?: boolean; overrideBudget?: boolean; overrideReason?: string }) {
    const db = this.db;
    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, prNo)).limit(1);
    if (!pr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบ PR' });
    // FIN-3 (BUD-02) — budgetary-control gate at PR approval (requesters are never blocked from ASKING —
    // createPr is ungated by design; the control binds where spend is authorised). PR lines carry no prices,
    // so the estimate comes from the item master; the approved PR's estimate is encumbered as an open
    // commitment until it converts to POs (which then carry the real commitment). glGate returns null when
    // the tenant policy is 'off' (default) and throws BUDGET_EXCEEDED / BUDGET_CONFIRM_REQUIRED per policy.
    let budgetGate: Awaited<ReturnType<CommitmentsService['glGate']>> = null;
    if (approve && this.commitments && pr.status !== 'Approved') {
      budgetGate = await this.commitments.glGateForDoc('PR', prNo, {
        tenantId: user.tenantId ?? null, user,
        confirm: budgetOpts?.confirmOverBudget, override: budgetOpts?.overrideBudget, overrideReason: budgetOpts?.overrideReason,
      });
    }
    // if a workflow is configured (a live instance exists), route the decision through the engine —
    // maker-checker + multi-level + SoD all enforced there. Otherwise fall back to the legacy Admin-only flip.
    const inst = this.workflow ? await this.workflow.pendingInstanceFor('PR', prNo) : null;
    let newStatus: string;
    if (inst) {
      await this.workflow!.act(Number(inst.id), { decision: approve ? 'approve' : 'reject' }, user);
      const cleared = await this.workflow!.canTransition('PR', prNo);
      newStatus = approve ? (cleared ? 'Approved' : 'Pending') : 'Rejected'; // 'Pending' = more steps remain
      await db.update(purchaseRequests).set({ status: newStatus, approvedBy: user.username, approvedAt: new Date() }).where(eq(purchaseRequests.id, pr.id));
      if (newStatus !== pr.status) await this.statusLog.log('PR', prNo, pr.status ?? '', newStatus, user.username);
    } else {
      if (user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin only', messageTh: 'เฉพาะผู้ดูแล' });
      newStatus = approve ? 'Approved' : 'Rejected';
      await db.update(purchaseRequests).set({ status: newStatus, approvedBy: user.username, approvedAt: new Date() }).where(eq(purchaseRequests.id, pr.id));
      await this.statusLog.log('PR', prNo, pr.status ?? '', newStatus, user.username);
    }
    // BUD-02 — the final approval encumbers the PR's estimated spend; an authorised overage is audited.
    if (budgetGate && newStatus === 'Approved') {
      await this.commitments!.glReserve(db, budgetGate, { docType: 'PR', docNo: prNo, tenantId: user.tenantId ?? null, user });
      if (budgetGate.overridden) await this.statusLog.log('PR', prNo, 'Pending', 'Approved', user.username, `BUDGET_OVERRIDE (BUD-02): ${budgetGate.override_reason}`);
    }
    return { pr_no: prNo, status: newStatus, ...(budgetGate ? { budget: { policy: budgetGate.policy, exceeded: budgetGate.exceeded, overridden: budgetGate.overridden, checks: budgetGate.checks } } : {}) };
  }

  // Requester withdraws their own still-Pending PR (0228 — also reachable from the LINE chat `cancel`
  // command). Own-doc only (Admin may cancel any); the pending workflow instance is closed alongside so
  // the approval queue carries no orphan. A decided (Approved/Rejected) PR cannot be cancelled.
  async cancelPr(prNo: string, user: JwtUser) {
    const db = this.db;
    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, prNo)).limit(1);
    if (!pr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบ PR' });
    if (pr.requestedBy !== user.username && user.role !== 'Admin') {
      throw new ForbiddenException({ code: 'PR_NOT_YOURS', message: 'Only the requester can cancel their PR', messageTh: 'ยกเลิกได้เฉพาะคำขอของตนเอง' });
    }
    if (pr.status !== 'Pending') {
      throw new BadRequestException({ code: 'PR_NOT_PENDING', message: `Cannot cancel a '${pr.status}' PR`, messageTh: `ยกเลิกไม่ได้: PR สถานะ '${pr.status}'` });
    }
    await db.update(purchaseRequests).set({ status: 'Cancelled' }).where(eq(purchaseRequests.id, pr.id));
    await this.statusLog.log('PR', prNo, pr.status ?? '', 'Cancelled', user.username);
    await this.workflow?.cancel('PR', prNo);
    return { pr_no: prNo, status: 'Cancelled' };
  }

  // List recent PRs (header + lines) for the web requisitions screen. `mine` scopes to the caller's own
  // requests (the default for a plain pr_raise holder); procurement/planner/exec see every PR so they can
  // approve. Newest first. purchase_requests has no tenant_id (company-wide document), so no tenant filter.
  async listPrs(user: JwtUser, opts?: { limit?: number; mine?: boolean }) {
    const db = this.db;
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const canSeeAll = (user.permissions ?? []).some((p) => ['procurement', 'planner', 'exec'].includes(p)) || user.role === 'Admin';
    const scopeMine = opts?.mine ?? !canSeeAll;
    const heads = await db.select().from(purchaseRequests)
      .where(scopeMine ? eq(purchaseRequests.requestedBy, user.username ?? '') : sql`true`)
      .orderBy(desc(purchaseRequests.id)).limit(limit);
    if (!heads.length) return { prs: [], can_approve: canSeeAll };
    const ids = heads.map((h: any) => Number(h.id));
    const lines = await db.select().from(prItems).where(sql`${prItems.prId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    // Enrich the display name: pr_items.item_description is captured at raise-time (shop checkout / manual),
    // but a chat-raised line may only carry the code — backfill the name from the item master so every line
    // shows a human name, not just a code (the reported "ดึงชื่อสินค้ามาด้วย"). Company-wide `items`, one lookup.
    const lineItemIds = [...new Set(lines.map((l: any) => l.itemId).filter(Boolean) as string[])];
    const nameMap = new Map<string, string>();
    if (lineItemIds.length) {
      const im = await db.select({ itemId: items.itemId, desc: items.itemDescription }).from(items).where(inArray(items.itemId, lineItemIds));
      for (const r of im) if (r.desc) nameMap.set(String(r.itemId), String(r.desc));
    }
    const byPr = new Map<number, any[]>();
    for (const l of lines) { const k = Number(l.prId); (byPr.get(k) ?? byPr.set(k, []).get(k)!).push(l); }
    return {
      can_approve: canSeeAll,
      prs: heads.map((h: any) => ({
        pr_no: h.prNo, pr_date: h.prDate, requested_by: h.requestedBy, status: h.status, priority: h.priority,
        approved_by: h.approvedBy ?? null,
        lines: (byPr.get(Number(h.id)) ?? []).map((l: any) => ({
          id: Number(l.id), item_id: l.itemId, item_description: l.itemDescription ?? nameMap.get(String(l.itemId)) ?? null,
          request_qty: n(l.requestQty), uom: l.uom ?? null, reason: l.reason ?? null,
          po_no: l.poNo ?? null, line_status: l.status ?? null,
        })),
      })),
    };
  }
  // One-tap reorder — raise a SINGLE PR covering every low-stock item at its suggested top-up qty (the
  // LINE chat `reorder` command + the web "เปิด PR เติมของ" button both land here). Runs the ordinary
  // createPr path, so numbering / status-log / approval workflow are unchanged. No low-stock item → 422.
  async reorderPr(user: JwtUser) {
    const low = (await this.lowStock(user)).items;
    if (!low.length) throw new UnprocessableEntityException({ code: 'NOTHING_LOW', message: 'No item is at/below its reorder point', messageTh: 'ไม่มีสินค้าที่ถึงจุดสั่งซื้อ' });
    const res = await this.createPr({
      remarks: 'เติมสต็อกสินค้าใกล้หมด (อัตโนมัติ)', priority: 'Normal',
      items: low.map((x) => ({ item_id: x.item_id, item_description: x.item_description ?? undefined, request_qty: x.suggested_qty, uom: x.uom ?? undefined, reason: 'ต่ำกว่าจุดสั่งซื้อ' })),
    }, user);
    return { pr_no: res.pr_no, status: res.status, lines: res.lines, items: low.map((x) => ({ item_id: x.item_id, qty: x.suggested_qty })) };
  }

  // Convert an APPROVED PR into one OR MORE POs. Each line arrives reconciled by procurement: an existing
  // item_id (picked from searchItems) OR a brand-new code to open (create_item:true → an items-master row).
  //
  // Two shapes, because "1 PO = 1 supplier" ⇒ a PR with lines for several suppliers must fan out:
  //  • LEGACY (`{ vendor, lines }`) — one PO for all lines; every PR line is stamped with it and the PR is
  //    marked Converted. Unchanged behaviour (the LINE-chat convert + older callers rely on it exactly).
  //  • SPLIT (`{ pos: [{ vendor, lines }, …] }`) — one PO per supplier group; each line is linked to its
  //    OWN PO by pr_line_id (precise) or item_id (fallback). The PR becomes 'Converted' only when every line
  //    is on a PO, else 'PartiallyConverted' so the remaining lines can be ordered in a later pass. A line
  //    may carry set_preferred:true to also record its group's vendor as the item's default (setPreferredVendor).
  // A Pending/Rejected PR 422s; a PartiallyConverted PR may be converted again (to place the rest).
  async convertPrToPo(prNo: string, dto: {
    vendor_id?: number; vendor_name?: string; expected_date?: string; remarks?: string; currency?: string; fx_rate?: number;
    lines?: ConvLine[];
    pos?: { vendor_id?: number; vendor_name?: string; expected_date?: string; remarks?: string; currency?: string; fx_rate?: number; lines: ConvLine[] }[];
  }, user: JwtUser) {
    const db = this.db;
    const pr = prNo.toUpperCase();
    const [head] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, pr)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบคำขอซื้อ' });
    if (head.status !== 'Approved' && head.status !== 'PartiallyConverted') throw new UnprocessableEntityException({ code: 'PR_NOT_APPROVED', message: `PR must be Approved to convert (is '${head.status}')`, messageTh: `ต้องอนุมัติ PR ก่อนแปลงเป็น PO (สถานะปัจจุบัน '${head.status}')` });

    const legacy = !(dto.pos && dto.pos.length);
    const groups = legacy
      ? [{ vendor_id: dto.vendor_id, vendor_name: dto.vendor_name, expected_date: dto.expected_date, remarks: dto.remarks, currency: dto.currency, fx_rate: dto.fx_rate, lines: dto.lines ?? [] }]
      : dto.pos!;
    const allLines = groups.flatMap((g) => g.lines ?? []);
    if (!allLines.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No lines', messageTh: 'ไม่มีรายการ' });
    for (const g of groups) if (!(g.lines?.length)) throw new BadRequestException({ code: 'EMPTY_PO', message: 'Each PO needs at least one line', messageTh: 'ใบสั่งซื้อทุกใบต้องมีอย่างน้อย 1 รายการ' });
    for (const l of allLines) {
      if (!l.item_id?.trim()) throw new BadRequestException({ code: 'ITEM_REQUIRED', message: 'Each line needs a resolved item id', messageTh: 'ทุกบรรทัดต้องเลือกหรือเปิดรหัสสินค้า' });
      if (!(n(l.order_qty) > 0)) throw new BadRequestException({ code: 'BAD_QTY', message: `Bad qty for ${l.item_id}`, messageTh: `จำนวนไม่ถูกต้อง: ${l.item_id}` });
    }
    // Open any brand-new item codes first (idempotent — a code that already exists is left as-is).
    const created: string[] = [];
    for (const l of allLines.filter((x) => x.create_item)) {
      const code = l.item_id.trim();
      const [exists] = await db.select({ id: items.id }).from(items).where(eq(items.itemId, code)).limit(1);
      if (!exists) {
        await db.insert(items).values({ itemId: code, itemDescription: l.item_description ?? code, uom: l.uom ?? null, unitPrice: String(n(l.unit_price)) }).onConflictDoNothing();
        created.push(code);
      }
    }

    // Raise one PO per group through the normal path (vendor screening + workflow), then link the PR lines.
    const createdPos: { po_no: string; status: string; total_amount: number; vendor_id: number | null; vendor_name: string | null; line_count: number }[] = [];
    for (const g of groups) {
      // Resolve the group vendor id up front (for set_preferred); createPo re-resolves for the PO row itself.
      let gVendorId = g.vendor_id ?? null;
      if (!gVendorId && g.vendor_name?.trim()) { const [v] = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.name, g.vendor_name.trim())).limit(1); gVendorId = v?.id ?? null; }
      const po = await this.createPo({
        vendor_id: gVendorId ?? undefined, vendor_name: g.vendor_name, expected_date: g.expected_date,
        remarks: g.remarks ?? `จาก ${pr}`, currency: g.currency, fx_rate: g.fx_rate,
        items: g.lines.map((l) => ({ item_id: l.item_id.trim(), item_description: l.item_description, order_qty: n(l.order_qty), unit_price: n(l.unit_price), uom: l.uom, is_capital: l.is_capital })),
      }, user);
      createdPos.push({ po_no: po.po_no, status: po.status, total_amount: po.total_amount, vendor_id: gVendorId, vendor_name: g.vendor_name ?? null, line_count: g.lines.length });

      if (legacy) {
        // Preserve the historical behaviour exactly: blanket-stamp every PR line with the single PO number.
        await db.update(prItems).set({ poNo: po.po_no }).where(eq(prItems.prId, Number(head.id)));
      } else {
        // Split: link each group line to THIS PO precisely — by pr_line_id, else the first still-unlinked
        // PR line with the same item code. Only stamp rows not already on a PO (idempotent across passes).
        for (const l of g.lines) {
          if (l.pr_line_id != null) {
            await db.update(prItems).set({ poNo: po.po_no, status: 'Converted' })
              .where(and(eq(prItems.id, Number(l.pr_line_id)), eq(prItems.prId, Number(head.id)), isNull(prItems.poNo)));
          } else {
            const [cand] = await db.select({ id: prItems.id }).from(prItems)
              .where(and(eq(prItems.prId, Number(head.id)), eq(prItems.itemId, l.item_id.trim()), isNull(prItems.poNo))).limit(1);
            if (cand) await db.update(prItems).set({ poNo: po.po_no, status: 'Converted' }).where(eq(prItems.id, Number(cand.id)));
          }
          // Learn the item's default supplier when the buyer asks to (best-effort; never fails the convert).
          if (l.set_preferred && gVendorId) {
            try { await this.setPreferredVendor(l.item_id.trim(), { vendor_id: gVendorId, unit_price: n(l.unit_price), uom: l.uom }, user); } catch { /* preference is a nicety, not a gate */ }
          }
        }
      }
    }

    // PR status: legacy always fully closes; split closes only when no line remains unlinked.
    let newStatus = 'Converted';
    if (!legacy) {
      const remaining = await db.select({ id: prItems.id }).from(prItems).where(and(eq(prItems.prId, Number(head.id)), isNull(prItems.poNo)));
      newStatus = remaining.length === 0 ? 'Converted' : 'PartiallyConverted';
    }
    await db.update(purchaseRequests).set({ status: newStatus }).where(eq(purchaseRequests.id, head.id));
    if (newStatus !== head.status) await this.statusLog.log('PR', pr, head.status ?? '', newStatus, user.username);
    // FIN-3 (BUD-02) — the PO(s) raised above now carry the real commitment (recorded at PO approval), so
    // the PR's estimate-based commitment is released at first conversion (no-op when the gate was off).
    if (this.commitments) await this.commitments.glRelease(db, 'PR', pr);
    // D2 — tell the requester their requisition is now on purchase order(s) (best-effort LINE push).
    if (head.requestedBy && head.requestedBy !== user.username) {
      const poList = createdPos.map((p) => p.po_no).join(', ');
      await this.lineNotify?.notifyUser(String(head.requestedBy), null, `🛒 คำขอซื้อ ${pr} ของคุณออกใบสั่งซื้อแล้ว → ${poList}${newStatus === 'PartiallyConverted' ? ' (ยังมีรายการค้างรอสั่งเพิ่ม)' : ''}`);
    }
    const first = createdPos[0];
    return {
      pr_no: pr, pr_status: newStatus,
      po_no: first?.po_no ?? null, po_status: first?.status ?? null, // legacy fields (first PO)
      total_amount: createdPos.reduce((a, p) => a + n(p.total_amount), 0),
      pos: createdPos, created_items: created,
    };
  }
}
