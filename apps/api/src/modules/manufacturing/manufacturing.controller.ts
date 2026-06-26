import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ManufacturingService, type CreateWoDto } from './manufacturing.service';

const CreateWoBody = z.object({
  bom_code: z.string().min(1),
  qty_planned: z.number().positive(),
  product_item_id: z.string().optional(),
  product_name: z.string().optional(),
});
const CompleteBody = z.object({ qty_produced: z.number().positive().optional(), actual_material: z.number().nonnegative().optional() });

@Controller('api/manufacturing')
@Permissions('bom_master', 'warehouse', 'exec')
export class ManufacturingController {
  constructor(private readonly svc: ManufacturingService) {}

  @Post('work-orders')
  create(@Body(new ZodValidationPipe(CreateWoBody)) b: CreateWoDto, @CurrentUser() u: JwtUser) {
    return this.svc.createWorkOrder(b, u);
  }

  @Get('work-orders')
  list(@CurrentUser() u: JwtUser) {
    return this.svc.list(u);
  }

  @Get('work-orders/:woNo')
  get(@Param('woNo') woNo: string) {
    return this.svc.get(woNo);
  }

  @Post('work-orders/:woNo/issue')
  issue(@Param('woNo') woNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.issue(woNo, u);
  }

  @Post('work-orders/:woNo/complete')
  complete(@Param('woNo') woNo: string, @Body(new ZodValidationPipe(CompleteBody)) b: { qty_produced?: number; actual_material?: number }, @CurrentUser() u: JwtUser) {
    return this.svc.complete(woNo, b.qty_produced, u, b.actual_material);
  }
}
