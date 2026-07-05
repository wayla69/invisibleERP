import { Controller, Get, Post, Patch, Delete, Param, Query, Body, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProcurementService, type CreatePrDto, type CreatePoDto, type CreateGrDto, type UpsertSupplierPriceDto } from './procurement.service';
import { AttachmentsService, type AddAttachmentDto } from './attachments.service';
import { PoPdfService } from './po-pdf.service';

const AttachmentBody = z.object({
  doc_type: z.string().min(1), doc_no: z.string().min(1), data_url: z.string().min(1),
  kind: z.enum(['invoice', 'receipt', 'other']).optional(), filename: z.string().max(200).optional(), note: z.string().max(500).optional(),
});

const PrBody = z.object({
  remarks: z.string().optional(), priority: z.string().optional(),
  amount: z.number().nonnegative().optional(), // estimated value → drives approval-threshold routing
  project_code: z.string().optional(), // M0 (docs/32) — raise the requisition against a project's BoQ
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), request_qty: z.number().positive(), uom: z.string().optional(), required_date: z.string().optional(), reason: z.string().optional(), boq_line_id: z.number().int().positive().optional() })).min(1),
});
const PoBody = z.object({
  vendor_id: z.number().optional(), vendor_name: z.string().optional(), expected_date: z.string().optional(), remarks: z.string().optional(),
  project_code: z.string().optional(), // M0 (docs/32) — project PO commits material against the project's BoQ
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), order_qty: z.number().positive(), unit_price: z.number().nonnegative(), uom: z.string().optional(), is_capital: z.boolean().optional(), boq_line_id: z.number().int().positive().optional() })).min(1),
});
const GrBody = z.object({
  po_no: z.string().min(1), remarks: z.string().optional(),
  items: z.array(z.object({ item_id: z.string().min(1), received_qty: z.number().positive(), lot_no: z.string().optional(), expiry_date: z.string().optional(), unit_cost: z.number().optional(), uom: z.string().optional() })).min(1),
});
const ApproveBody = z.object({ approve: z.boolean().default(true), reason: z.string().optional() });
// PR → PO conversion: each line is reconciled to a real item (existing code, or create_item:true to open a new one) + priced.
const PrToPoBody = z.object({
  vendor_id: z.number().optional(), vendor_name: z.string().optional(), expected_date: z.string().optional(), remarks: z.string().optional(),
  currency: z.string().optional(), fx_rate: z.number().optional(),
  lines: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), create_item: z.boolean().optional(), order_qty: z.number().positive(), unit_price: z.number().nonnegative(), uom: z.string().optional(), is_capital: z.boolean().optional() })).min(1),
});
const CancelBody = z.object({ reason: z.string().min(1) });
// to_email optional — defaults to the vendor's email on file (master data) when omitted.
const DocEmailBody = z.object({ to_email: z.string().email().optional() });
// D4 — receive a partial qty of one PO line.
const ReceiveItemBody = z.object({ item_id: z.string().min(1), qty: z.number().positive() });
const SupplierStatusBody = z.object({ approval_status: z.enum(['approved', 'pending', 'blocked']).optional(), blocklisted: z.boolean().optional(), reason: z.string().optional() });
const ScorecardBody = z.object({ period: z.string().min(1) });
// T2-D: Supplier price-list versioning — create/version a purchase price; list active; history.
const SupplierPriceBody = z.object({
  vendor_id: z.number().int().positive(),
  item_id: z.string().min(1),
  item_description: z.string().optional(),
  uom: z.string().optional(),
  currency: z.string().optional(),
  unit_price: z.number().positive(),
  min_qty: z.number().positive().optional(),
  effective_from: z.string().min(1), // YYYY-MM-DD
  effective_to: z.string().optional(),
  notes: z.string().optional(),
});

@Controller('api/procurement')
export class ProcurementController {
  constructor(private readonly svc: ProcurementService, private readonly attachments: AttachmentsService, private readonly poPdf: PoPdfService) {}

  // ── Document attachments (0228) — invoice/receipt photos on a PO (evidence for the 3-way match). ──
  // Upload: the people who handle the paper — buyer (procurement), AP clerk (creditors), receiver
  // (wh_receive). View adds planner/exec. Delete is service-enforced to uploader-or-Admin.
  @Post('attachments') @Permissions('procurement', 'creditors', 'wh_receive')
  addAttachment(@Body(new ZodValidationPipe(AttachmentBody)) b: AddAttachmentDto, @CurrentUser() u: JwtUser) { return this.attachments.add(b, u); }
  @Get('attachments') @Permissions('procurement', 'creditors', 'wh_receive', 'planner', 'exec')
  listAttachments(@Query('doc_type') docType: string, @Query('doc_no') docNo: string, @CurrentUser() u: JwtUser) { return this.attachments.list(docType ?? 'PO', docNo ?? '', u); }
  @Get('attachments/:id') @Permissions('procurement', 'creditors', 'wh_receive', 'planner', 'exec')
  getAttachment(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.attachments.get(+id, u); }
  @Delete('attachments/:id') @Permissions('procurement', 'creditors', 'wh_receive')
  removeAttachment(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.attachments.remove(+id, u); }

  // PR = a request anyone in the company can raise (pr_raise). It is NOT a commitment — approval + PO
  // remain procurement-only. 'procurement'/'planner' imply pr_raise, so buyers/planners still qualify.
  @Post('prs') @Permissions('pr_raise', 'procurement', 'planner')
  createPr(@Body(new ZodValidationPipe(PrBody)) b: CreatePrDto, @CurrentUser() u: JwtUser) { return this.svc.createPr(b, u); }

  // List recent PRs (header + lines) for the requisitions screen. pr_raise holders see their own; a
  // procurement/planner/exec holder sees every PR (can_approve:true) so they can decide from the table.
  @Get('prs') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  listPrs(@CurrentUser() u: JwtUser, @Query('limit') limit?: string, @Query('mine') mine?: string) {
    return this.svc.listPrs(u, { limit: limit ? Number(limit) : undefined, mine: mine === 'true' ? true : mine === 'false' ? false : undefined });
  }

  @Patch('prs/:prNo/approve') @Permissions('procurement')
  approvePr(@Param('prNo') prNo: string, @Body(new ZodValidationPipe(ApproveBody)) b: { approve: boolean }, @CurrentUser() u: JwtUser) {
    return this.svc.approvePr(prNo, b.approve, u);
  }

  // Requester withdraws their own still-Pending PR (own-doc only; Admin may cancel any) — 0228.
  @Patch('prs/:prNo/cancel') @Permissions('pr_raise', 'procurement', 'planner')
  cancelPr(@Param('prNo') prNo: string, @CurrentUser() u: JwtUser) { return this.svc.cancelPr(prNo, u); }

  // Item-master search for the PR→PO reconcile step (match a free-text PR name to a real item + last price).
  @Get('items/search') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  searchItems(@Query('q') q: string, @Query('limit') limit?: string) { return this.svc.searchItems(q ?? '', limit ? Number(limit) : undefined); }

  // Product catalog for the shop/basket requisition screen (/shop) — read-only item-master browse grouped
  // by product category, so staff can pick items into a basket and check out a PR. Same low-risk pr_raise
  // duty as raising the PR itself. Paginated (offset/limit) for the Grab/Shopee-style infinite-scroll grid;
  // optional q (code/description) + category-key filter. Returns the item page + the full category summary.
  @Get('catalog') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  catalog(@CurrentUser() u: JwtUser, @Query('q') q?: string, @Query('category') category?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.svc.catalog(u, { q, category, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
  }

  // Catalog item thumbnail (pr_raise) — the in-DB image data-URL for a shop-grid <img>. 404 if none.
  @Get('catalog/items/:itemId/image') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  catalogItemImage(@Param('itemId') itemId: string, @CurrentUser() u: JwtUser) { return this.svc.catalogItemImage(u, itemId); }

  // Vendor search for the PR→PO panel (pick a real supplier from the master).
  @Get('vendors/search') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  searchVendors(@Query('q') q: string, @Query('limit') limit?: string) { return this.svc.searchVendors(q ?? '', limit ? Number(limit) : undefined); }

  // Low-stock reorder list — items at/below their reorder point (on-hand vs items.min_stock), with a
  // suggested top-up qty. Feeds the "สินค้าใกล้หมด" web card + the LINE chat `low` command.
  @Get('low-stock') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  lowStock(@CurrentUser() u: JwtUser, @Query('limit') limit?: string) { return this.svc.lowStock(u, { limit: limit ? Number(limit) : undefined }); }

  // One-tap reorder — raise a single PR covering all low-stock items (chat `reorder` + web button).
  @Post('reorder-pr') @Permissions('pr_raise', 'procurement', 'planner')
  reorderPr(@CurrentUser() u: JwtUser) { return this.svc.reorderPr(u); }

  // D3 — purchase spend insights for a business month: total + top vendors + most-bought items.
  @Get('spend-summary') @Permissions('procurement', 'planner', 'exec', 'dashboard')
  spendSummary(@CurrentUser() u: JwtUser, @Query('period') period?: string) { return this.svc.purchaseSpend(u, { period }); }

  // Convert an approved PR → PO (procurement duty). Lines arrive reconciled (existing item_id or a new
  // code to open); the PO routes through the normal createPo path and the PR is linked + marked Converted.
  @Post('prs/:prNo/to-po') @Permissions('procurement')
  convertPrToPo(@Param('prNo') prNo: string, @Body(new ZodValidationPipe(PrToPoBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.convertPrToPo(prNo, b, u);
  }

  // Receive ALL outstanding qty on an approved PO in one shot (LINE chat `receive` + web "รับครบ").
  @Post('pos/:poNo/receive-all') @Permissions('wh_receive', 'warehouse', 'procurement')
  receiveAll(@Param('poNo') poNo: string, @CurrentUser() u: JwtUser) { return this.svc.receiveAllRemaining(poNo, u); }

  // D4 — receive a partial qty of ONE item on an approved PO (LINE chat `receive <PO> <item> <qty>`).
  @Post('pos/:poNo/receive-item') @Permissions('wh_receive', 'warehouse', 'procurement')
  receiveItem(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(ReceiveItemBody)) b: z.infer<typeof ReceiveItemBody>, @CurrentUser() u: JwtUser) {
    return this.svc.receiveItem(poNo, b.item_id, b.qty, u);
  }

  // ── supplier screening (Phase 16) ── vendor-master duty = md_vendor (segregated from AP payment).
  // Legacy 'masterdata' holders still pass (it implies md_vendor/md_item/md_config).
  @Patch('suppliers/:id/status') @Permissions('md_vendor')
  setSupplierStatus(@Param('id') id: string, @Body(new ZodValidationPipe(SupplierStatusBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setSupplierStatus(+id, b, u); }
  @Post('suppliers/:id/scorecard') @Permissions('procurement')
  scorecard(@Param('id') id: string, @Body(new ZodValidationPipe(ScorecardBody)) b: { period: string }, @CurrentUser() u: JwtUser) { return this.svc.recomputeScorecard(+id, b.period, u); }

  // Supplier-performance register — scorecards ranked by score (with ?period; default = latest per vendor).
  @Get('scorecards') @Permissions('procurement', 'exec')
  scorecards(@CurrentUser() u: JwtUser, @Query('period') period?: string, @Query('limit') limit?: string) {
    return this.svc.listScorecards({ period, limit: limit ? Math.min(Number(limit) || 200, 500) : 200 }, u);
  }

  // T2-D: Supplier price-list versioning. md_vendor creates/versions prices; procurement/planner/exec view.
  // SoD: price maintenance (md_vendor) is segregated from buying (procurement) and paying (creditors).
  @Post('supplier-prices') @Permissions('md_vendor', 'procurement')
  upsertSupplierPrice(@Body(new ZodValidationPipe(SupplierPriceBody)) b: UpsertSupplierPriceDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertSupplierPrice(b, u);
  }
  @Get('supplier-prices') @Permissions('procurement', 'planner', 'exec')
  listSupplierPrices(@CurrentUser() u: JwtUser, @Query('vendor_id') vendorId?: string, @Query('item_id') itemId?: string) {
    return this.svc.listSupplierPrices({ vendor_id: vendorId ? Number(vendorId) : undefined, item_id: itemId }, u);
  }
  @Get('supplier-prices/history') @Permissions('procurement', 'planner')
  supplierPriceHistory(@CurrentUser() u: JwtUser, @Query('vendor_id') vendorId: string, @Query('item_id') itemId: string) {
    return this.svc.supplierPriceHistory(Number(vendorId), itemId, u);
  }

  @Post('pos') @Permissions('procurement')
  createPo(@Body(new ZodValidationPipe(PoBody)) b: CreatePoDto, @CurrentUser() u: JwtUser) { return this.svc.createPo(b, u); }

  @Patch('pos/:poNo/approve') @Permissions('procurement')
  approvePo(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(ApproveBody)) b: { approve: boolean; reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.approvePo(poNo, b.approve, b.reason, u);
  }

  @Patch('pos/:poNo/cancel') @Permissions('procurement')
  cancelPo(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(CancelBody)) b: { reason: string }, @CurrentUser() u: JwtUser) {
    return this.svc.cancelPo(poNo, b.reason, u);
  }

  // Printable ใบสั่งซื้อ (Purchase Order) — HTML→PDF via the shared PdfRenderer, HTML fallback when Chromium
  // is absent (same graceful-degrade contract as the tax documents). Viewing is open to the buying/receiving
  // roles + planner/exec who track the order (read-only presentation; no ledger effect).
  @Get('pos/:poNo/pdf') @Permissions('procurement', 'planner', 'exec', 'wh_receive', 'warehouse')
  async printPo(@Param('poNo') poNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const po = await this.svc.getPoForPrint(poNo, u);
    const html = this.poPdf.purchaseOrderHtml(po, po.template);
    const buf = await this.poPdf.renderToPdf(html);
    if (buf) {
      reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${poNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    } else {
      reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
    }
  }

  // GR = a warehouse/receiving duty (wh_receive), deliberately segregated from purchase ordering so the
  // buyer cannot also confirm receipt (SoD R04 — preserves the 3-way match). Coarse 'warehouse' implies
  // wh_receive, so existing warehouse roles keep access; 'procurement' alone no longer can receive.
  @Post('grs') @Permissions('wh_receive')
  createGr(@Body(new ZodValidationPipe(GrBody)) b: CreateGrDto, @CurrentUser() u: JwtUser) { return this.svc.createGr(b, u); }

  // Recent goods receipts — the /receiving list surface (print/email each GR note).
  @Get('grs') @Permissions('wh_receive', 'warehouse', 'procurement', 'creditors', 'exec')
  listGrs(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listGrs(u, limit ? Number(limit) : 50); }

  // Printable ใบรับสินค้า (Goods Receipt Note) — HTML→PDF, HTML fallback when Chromium absent.
  @Get('grs/:grNo/pdf') @Permissions('wh_receive', 'warehouse', 'procurement', 'creditors', 'exec')
  async grPdf(@Param('grNo') grNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const g = await this.svc.getGrForPrint(grNo, u);
    const buf = await this.svc.renderGrPdf(g);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${grNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.svc.goodsReceiptHtml(g));
  }
  @Post('grs/:grNo/send-email') @Permissions('wh_receive', 'warehouse', 'procurement')
  emailGr(@Param('grNo') grNo: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailGr(grNo, b.to_email, u);
  }
}
