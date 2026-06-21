import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { IntercompanyService } from './intercompany.service';
import { CreateIcBody, SettleIcBody, type CreateIcDto, type SettleIcDto } from './dto';

// ระหว่างกิจการ — mirrored due-from/due-to across tenants + elimination/reconciliation (HQ posts both legs).
@Controller('api/intercompany')
@Permissions('exec', 'creditors')
export class IntercompanyController {
  constructor(private readonly svc: IntercompanyService) {}

  @Post() create(@Body(new ZodValidationPipe(CreateIcBody)) b: CreateIcDto, @CurrentUser() u: JwtUser) { return this.svc.createIcTransaction(b, u); }
  @Get() list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listIc(u, status); }
  @Get('reconciliation') reconciliation(@CurrentUser() u: JwtUser) { return this.svc.reconciliation(u); }
  @Get(':icNo') get(@Param('icNo') icNo: string, @CurrentUser() u: JwtUser) { return this.svc.getIc(icNo, u); }
  @Post(':icNo/settle') settle(@Param('icNo') icNo: string, @Body(new ZodValidationPipe(SettleIcBody)) b: SettleIcDto, @CurrentUser() u: JwtUser) { return this.svc.settleIc(icNo, b, u); }
}
