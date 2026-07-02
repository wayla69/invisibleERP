import { Controller, Get, Post, Delete, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { PosAuditService } from './pos-audit.service';
import { qint, qintOpt } from '../../../common/query';

const ReasonBody = z.object({ id: z.number().optional(), code: z.string().min(1), label: z.string().min(1), applies_to: z.string().optional(), active: z.boolean().optional() });

@Controller('api/pos/audit')
@Permissions('pos', 'order_mgt', 'exec')
export class PosAuditController {
  constructor(private readonly svc: PosAuditService) {}

  @Get() list(@Query('limit') limit?: string, @Query('action') action?: string) { return this.svc.listPosAudit(qint('limit', limit, 100), action); }

  @Get('reason-codes') reasons(@Query('applies_to') appliesTo?: string) { return this.svc.listReasonCodes(appliesTo); }
  @Post('reason-codes') upsertReason(@Body(new ZodValidationPipe(ReasonBody)) b: z.infer<typeof ReasonBody>, @CurrentUser() u: JwtUser) { return this.svc.upsertReasonCode(b, u); }
  @Delete('reason-codes/:id') delReason(@Param('id') id: string) { return this.svc.deleteReasonCode(+id); }
}
