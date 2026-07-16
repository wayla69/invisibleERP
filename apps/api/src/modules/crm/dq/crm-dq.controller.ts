import { Controller, Get, Post, Param, Query, HttpCode } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { CrmDqService } from './crm-dq.service';

// CRM-17 CRM data-quality — reads gate crm/exec/ar (same as accounts); the snapshot job gates crm/exec.
@Controller('api/crm/dq')
@Permissions('crm', 'exec', 'ar')
export class CrmDqController {
  constructor(private readonly svc: CrmDqService) {}

  @Get() worklist(@Query('band') band: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.worklist(u, { band }); }
  @Get('duplicates') duplicates(@Query('threshold') threshold: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.duplicateCandidates(u, { threshold: threshold != null ? Number(threshold) : undefined }); }
  @Get('merge-log') mergeLog(@CurrentUser() u: JwtUser) { return this.svc.mergeLog(u); }
  @Get('account/:accountNo') accountDq(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.accountDq(no, u); }
  @Get('history/:accountNo') history(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.dqHistory(no, u); }
  @Post('snapshot') @HttpCode(200) @Permissions('crm', 'exec') snapshot(@CurrentUser() u: JwtUser) { return this.svc.captureAllDq(u); }
}
