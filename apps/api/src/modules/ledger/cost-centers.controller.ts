import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CostCentersService, type CostCenterDto } from './cost-centers.service';
import { LedgerService } from './ledger.service';

const CostCenterBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['department', 'branch', 'project']).optional(),
  parent_code: z.string().optional(),
});

// ศูนย์ต้นทุน / มิติบัญชี — master + per-cost-center P&L (dimensional reporting over the GL).
@Controller('api/ledger/cost-centers')
@Permissions('exec', 'masterdata')
export class CostCentersController {
  constructor(private readonly svc: CostCentersService, private readonly ledger: LedgerService) {}

  @Post() create(@Body(new ZodValidationPipe(CostCenterBody)) b: CostCenterDto, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }
  @Get() list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }
  @Get(':code/pl') pl(@Param('code') code: string, @Query('from') from: string, @Query('to') to: string) { return this.ledger.incomeStatement(from, to, code); }
}
