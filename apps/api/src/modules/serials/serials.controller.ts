import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SerialsService } from './serials.service';

// docs/52 Phase 3b — serial/IMEI unit register. Adding units to stock and listing them is a master-data /
// warehouse-receiving act (mirrors the item-setup duties + goods-receiving); the sale-time consumption runs
// inside the POS sale path (guarded by the selling duty there), not here.
const AddSerialsBody = z.object({ serials: z.array(z.string().trim().min(1).max(64)).min(1).max(500) });

@Controller('api/serials')
@Permissions('md_item', 'md_config', 'masterdata', 'wh_receive', 'warehouse', 'exec')
export class SerialsController {
  constructor(private readonly svc: SerialsService) {}

  @Post('items/:itemId')
  addSerials(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(AddSerialsBody)) b: z.infer<typeof AddSerialsBody>, @CurrentUser() u: JwtUser) {
    return this.svc.addSerials(itemId, b.serials, u);
  }

  @Get('items/:itemId')
  listSerials(@Param('itemId') itemId: string, @Query('status') status: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listSerials(itemId, status, u);
  }
}
