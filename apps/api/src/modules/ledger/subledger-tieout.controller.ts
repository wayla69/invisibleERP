import { Controller, Get, Post, Body, Param, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SubledgerTieoutService } from './subledger-tieout.service';

const RunBody = z.object({
  subledger: z.enum(['AR', 'AP', 'INV', 'FA']),
  as_of_date: z.string().optional(),
});
type RunBodyT = z.infer<typeof RunBody>;

const CertifyBody = z.object({ note: z.string().optional() });
type CertifyBodyT = z.infer<typeof CertifyBody>;

// GL-14 — Sub-ledger tie-out / reconciliation. Run reconciles a control account's GL balance vs its
// sub-ledger detail; certify is maker-checker (certifier ≠ runner).
@Controller('api/ledger/tie-out')
export class SubledgerTieoutController {
  constructor(private readonly svc: SubledgerTieoutService) {}

  @Get()
  @Permissions('gl_close', 'gl_post', 'exec', 'creditors', 'ar')
  list(@Query('subledger') subledger?: string, @Query('as_of_date') asOfDate?: string) {
    return this.svc.list({ subledger, asOfDate });
  }

  @Get(':id')
  @Permissions('gl_close', 'gl_post', 'exec', 'creditors', 'ar')
  get(@Param('id') id: string) {
    return this.svc.get(Number(id));
  }

  @Post('run')
  @Permissions('gl_close', 'gl_post')
  run(@Body(new ZodValidationPipe(RunBody)) b: RunBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.runTieOut({ subledger: b.subledger, asOfDate: b.as_of_date, runBy: u.username });
  }

  @Post(':id/certify')
  @HttpCode(200)
  @Permissions('gl_close')
  certify(@Param('id') id: string, @Body(new ZodValidationPipe(CertifyBody)) b: CertifyBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.certify({ id: Number(id), certifiedBy: u.username, note: b.note });
  }
}
