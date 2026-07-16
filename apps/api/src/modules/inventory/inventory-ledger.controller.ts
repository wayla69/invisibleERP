import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { InventoryLedgerService } from './inventory-ledger.service';
import { qint } from '../../common/query';

const ReceiveBody = z.object({
  item_id: z.string().min(1), item_description: z.string().optional(), uom: z.string().optional(),
  location_id: z.string().optional(), qty: z.number().positive(), unit_cost: z.number().min(0),
  ref_type: z.string().optional(), ref_id: z.string().optional(),
  costing_method: z.enum(['moving_avg', 'fifo', 'fefo']).optional(), lot_no: z.string().optional(), expiry_date: z.string().optional(),
});
const IssueBody = z.object({
  item_id: z.string().min(1), location_id: z.string().optional(), qty: z.number().positive(),
  ref_type: z.string().optional(), ref_id: z.string().optional(),
});
const AdjustBody = z.object({
  item_id: z.string().min(1), location_id: z.string().optional(), qty_delta: z.number(),
  reason: z.string().optional(),
});
const WriteoffRejectBody = z.object({ reason: z.string().optional() });
type ReceiveBodyT = z.infer<typeof ReceiveBody>;
type IssueBodyT = z.infer<typeof IssueBody>;
type AdjustBodyT = z.infer<typeof AdjustBody>;

// Perpetual inventory valuation sub-ledger (INV cycle). Receipts/issues post valued movements + GL;
// valuation + reconciliation tie the sub-ledger to the inventory control account (1200).
// SoD R11: receiving (wh_receive) ≠ issuing/custody (wh_custody) ≠ adjustment authority (wh_adjust) ≠ counting (wh_count).
@Controller('api/inventory')
export class InventoryLedgerController {
  constructor(private readonly svc: InventoryLedgerService) {}

  @Post('receipts')
  @Permissions('wh_receive')
  receive(@Body(new ZodValidationPipe(ReceiveBody)) b: ReceiveBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.receive(b, u);
  }

  @Post('issues')
  @Permissions('wh_custody')
  issue(@Body(new ZodValidationPipe(IssueBody)) b: IssueBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.issue(b, u);
  }

  // INV-04 — stock-adjustment authority is segregated from counting (R11): only wh_adjust may post.
  @Post('adjustments')
  @Permissions('wh_adjust')
  adjust(@Body(new ZodValidationPipe(AdjustBody)) b: AdjustBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.adjust(b, u);
  }

  @Get('valuation')
  @Permissions('wh_count', 'dashboard')
  valuation(@CurrentUser() u: JwtUser) {
    return this.svc.valuation(u);
  }

  // Open FIFO/FEFO cost layers (valuation depth for layer-costed items).
  @Get('layers')
  @Permissions('wh_count', 'dashboard')
  layers(@CurrentUser() u: JwtUser, @Query('item_id') itemId?: string) {
    return this.svc.layers(u, { item_id: itemId });
  }

  // INV-06 — sub-ledger ↔ GL control-account reconciliation.
  @Get('reconciliation')
  @Permissions('wh_count', 'dashboard')
  reconcile(@CurrentUser() u: JwtUser) {
    return this.svc.reconcile(u);
  }

  @Get('moves')
  @Permissions('wh_count', 'dashboard')
  moves(@CurrentUser() u: JwtUser, @Query('item_id') itemId?: string, @Query('limit') limit?: string) {
    return this.svc.listMoves(u, { item_id: itemId, limit: qint('limit', limit, 100) });
  }

  // INV-07 — inventory write-off maker-checker (theft concealment / SoD). A write-off request posts nothing
  // until a DIFFERENT wh_adjust holder approves; self-approval → SOD_VIOLATION.
  @Get('writeoffs')
  @Permissions('wh_count', 'dashboard')
  writeoffs(@CurrentUser() u: JwtUser, @Query('status') status?: string) {
    return this.svc.listWriteOffs(u, status);
  }

  @Post('writeoffs/:id/approve')
  @Permissions('wh_adjust')
  approveWriteoff(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveWriteOff(Number(id), u, b?.self_approval_reason);
  }

  @Post('writeoffs/:id/reject')
  @Permissions('wh_adjust')
  rejectWriteoff(@Param('id') id: string, @Body(new ZodValidationPipe(WriteoffRejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.rejectWriteOff(Number(id), u, b?.reason);
  }
}
