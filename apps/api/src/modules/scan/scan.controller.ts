import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ScanService } from './scan.service';
import { qint, qintOpt } from '../../common/query';

const OpenBody = z.object({ session_type: z.string().min(1), location_id: z.string().optional(), doc_ref: z.string().optional() });
const LineBody = z.object({ qr_data: z.string().min(1), qty: z.number().optional(), action: z.string().optional(), lot_no: z.string().optional(), client_uuid: z.string().optional() });

@Controller('api/scan/sessions')
@Permissions('mobile', 'warehouse')
export class ScanController {
  constructor(private readonly svc: ScanService) {}

  // Resolve a scanned code → item/asset (the /q deep-link resolver). Broad read access: any operator who
  // can scan on the floor (mobile/warehouse) or manage assets (exec/creditors) may identify a tag.
  @Get('resolve') @Permissions('mobile', 'warehouse', 'exec', 'creditors', 'dashboard') resolve(@Query('d') d: string) { return this.svc.resolve(d ?? ''); }

  @Post() open(@Body(new ZodValidationPipe(OpenBody)) b: z.infer<typeof OpenBody>, @CurrentUser() u: JwtUser) { return this.svc.open(b, u); }
  @Get() list(@Query('limit') limit?: string) { return this.svc.listSessions(qint('limit', limit, 50)); }
  @Get(':sessionNo') get(@Param('sessionNo') no: string) { return this.svc.getSession(no); }
  @Post(':sessionNo/lines') addLine(@Param('sessionNo') no: string, @Body(new ZodValidationPipe(LineBody)) b: z.infer<typeof LineBody>) { return this.svc.addLine(no, b); }
  @Post(':sessionNo/close') close(@Param('sessionNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.close(no, u); }
}
