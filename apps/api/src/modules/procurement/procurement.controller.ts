import { Controller, Post, Patch, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProcurementService, type CreatePrDto, type CreatePoDto, type CreateGrDto } from './procurement.service';

const PrBody = z.object({
  remarks: z.string().optional(), priority: z.string().optional(),
  amount: z.number().nonnegative().optional(), // estimated value → drives approval-threshold routing
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), request_qty: z.number().positive(), uom: z.string().optional(), required_date: z.string().optional(), reason: z.string().optional() })).min(1),
});
const PoBody = z.object({
  vendor_id: z.number().optional(), vendor_name: z.string().optional(), expected_date: z.string().optional(), remarks: z.string().optional(),
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), order_qty: z.number().positive(), unit_price: z.number().nonnegative(), uom: z.string().optional() })).min(1),
});
const GrBody = z.object({
  po_no: z.string().min(1), remarks: z.string().optional(),
  items: z.array(z.object({ item_id: z.string().min(1), received_qty: z.number().positive(), lot_no: z.string().optional(), expiry_date: z.string().optional(), unit_cost: z.number().optional(), uom: z.string().optional() })).min(1),
});
const ApproveBody = z.object({ approve: z.boolean().default(true), reason: z.string().optional() });
const CancelBody = z.object({ reason: z.string().min(1) });

@Controller('api/procurement')
export class ProcurementController {
  constructor(private readonly svc: ProcurementService) {}

  @Post('prs') @Permissions('procurement', 'planner')
  createPr(@Body(new ZodValidationPipe(PrBody)) b: CreatePrDto, @CurrentUser() u: JwtUser) { return this.svc.createPr(b, u); }

  @Patch('prs/:prNo/approve') @Permissions('procurement')
  approvePr(@Param('prNo') prNo: string, @Body(new ZodValidationPipe(ApproveBody)) b: { approve: boolean }, @CurrentUser() u: JwtUser) {
    return this.svc.approvePr(prNo, b.approve, u);
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

  @Post('grs') @Permissions('procurement', 'warehouse')
  createGr(@Body(new ZodValidationPipe(GrBody)) b: CreateGrDto, @CurrentUser() u: JwtUser) { return this.svc.createGr(b, u); }
}
