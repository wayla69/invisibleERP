import { Controller, Get, Post, Put, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EInvoiceService } from './einvoice.service';

const SubmitBody = z.object({ doc: z.object({ doc_ref: z.string().min(1), seller: z.string().optional(), buyer: z.string().optional(), total: z.number().optional(), lines: z.array(z.any()).optional() }) });
const ConfigBody = z.object({ provider: z.string().min(1) });

// C3 (Phase 22) — pluggable e-invoicing engine. Submit via the configured provider (stub by default); no GL.
@Controller('api/einvoice')
export class EInvoiceController {
  constructor(private readonly svc: EInvoiceService) {}

  @Get('providers') @Permissions('exec', 'creditors', 'ar') providers() { return this.svc.providers(); }
  @Get('config') @Permissions('exec', 'creditors', 'ar') getConfig(@CurrentUser() u: JwtUser) { return this.svc.config(u); }

  @Put('config') @Permissions('exec', 'creditors')
  setConfig(@Body(new ZodValidationPipe(ConfigBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setConfig(u, b.provider); }

  @Post('submit') @Permissions('exec', 'creditors', 'ar')
  submit(@Body(new ZodValidationPipe(SubmitBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.submit(u, b.doc); }

  @Get('submissions') @Permissions('exec', 'creditors', 'ar') submissions(@CurrentUser() u: JwtUser) { return this.svc.submissions(u); }
}
