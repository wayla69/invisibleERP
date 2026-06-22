import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ReconciliationService } from './reconciliation.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const OpenPeriodBody = z.object({ account_code: z.string().min(1), period: z.string().min(1) });
const AddItemBody = z.object({ source: z.enum(['Subledger', 'Adjustment']), amount: z.number(), ref_doc: z.string().optional(), notes: z.string().optional() });

@Controller('api/recon')
export class ReconciliationController {
  constructor(private readonly svc: ReconciliationService) {}

  @Get('periods')
  @Permissions('exec')
  listPeriods(@CurrentUser() user: JwtUser) {
    return this.svc.listPeriods(user);
  }

  @Post('periods')
  @Permissions('exec')
  openPeriod(@Body(new ZodValidationPipe(OpenPeriodBody)) dto: z.infer<typeof OpenPeriodBody>, @CurrentUser() user: JwtUser) {
    return this.svc.openPeriod(dto, user);
  }

  @Get('periods/:id/summary')
  @Permissions('exec')
  summary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.getPeriodSummary(id, user);
  }

  @Post('periods/:id/import-gl')
  @Permissions('exec')
  @HttpCode(200)
  importGl(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.importGlItems(id, user);
  }

  @Post('periods/:id/items')
  @Permissions('exec')
  addItem(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AddItemBody)) dto: z.infer<typeof AddItemBody>, @CurrentUser() user: JwtUser) {
    return this.svc.addItem(id, dto, user);
  }

  @Post('periods/:id/auto-match')
  @Permissions('exec')
  @HttpCode(200)
  autoMatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.autoMatch(id, user);
  }

  @Post('periods/:id/certify')
  @Permissions('approvals')
  @HttpCode(200)
  certify(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.certify(id, user);
  }
}
