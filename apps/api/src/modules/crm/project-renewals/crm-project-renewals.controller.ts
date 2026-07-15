import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmProjectRenewalsService, type RaiseRenewalDto } from './crm-project-renewals.service';

// CRM-18 CRM↔PPM back-flow — reads gate crm/exec/ar (same as the other CRM surfaces + the PPM audience).
const RaiseBody = z.object({ amount: z.number().nonnegative().optional(), name: z.string().optional() });

@Controller('api/crm/project-renewals')
@Permissions('crm', 'exec', 'ar')
export class CrmProjectRenewalsController {
  constructor(private readonly svc: CrmProjectRenewalsService) {}

  @Get()
  list(@CurrentUser() u: JwtUser) {
    return this.svc.listRenewals(u);
  }

  @Post(':projectCode/raise')
  raise(@Param('projectCode') projectCode: string, @Body(new ZodValidationPipe(RaiseBody)) b: RaiseRenewalDto, @CurrentUser() u: JwtUser) {
    return this.svc.raiseRenewal(projectCode, b, u);
  }
}
