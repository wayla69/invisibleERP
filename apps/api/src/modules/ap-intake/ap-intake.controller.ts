import { Controller, Get, Post, Put, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ApIntakeService } from './ap-intake.service';
import { qint } from '../../common/query';

const CreateBody = z.object({ text: z.string().min(1) });
const MapBody = z.object({ po_no: z.string().min(1) });
const PostBody = z.object({ po_no: z.string().min(1).optional(), allow_duplicate: z.boolean().optional() });

// AP invoice intake (EXP-10): scan → extract → PO auto-map → post bill → automated 3-way match.
// Booking the bill (post/auto) is a `creditors` action; scanning/mapping is open to procurement too.
// Payment itself stays behind the EXP-01 match gate + AP-PAY maker-checker — never automated here.
@Controller('api/procurement/ap-intake')
export class ApIntakeController {
  constructor(private readonly svc: ApIntakeService) {}

  @Post() @Permissions('procurement', 'creditors')
  create(@Body(new ZodValidationPipe(CreateBody)) b: { text: string }, @CurrentUser() u: JwtUser) { return this.svc.create(b.text, u); }

  // One-shot automation: extract → map → book → match. Falls back to a NeedsReview intake (no bill)
  // when the mapper is not confident or the invoice looks like a duplicate.
  @Post('auto') @Permissions('creditors')
  auto(@Body(new ZodValidationPipe(CreateBody)) b: { text: string }, @CurrentUser() u: JwtUser) { return this.svc.createAuto(b.text, u); }

  @Get() @Permissions('procurement', 'creditors')
  list(@CurrentUser() u: JwtUser, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.svc.list({ status, limit: qint('limit', limit, 100) }, u);
  }

  @Get(':intakeNo') @Permissions('procurement', 'creditors')
  get(@Param('intakeNo') intakeNo: string) { return this.svc.get(intakeNo); }

  @Put(':intakeNo/map') @Permissions('procurement', 'creditors')
  map(@Param('intakeNo') intakeNo: string, @Body(new ZodValidationPipe(MapBody)) b: { po_no: string }, @CurrentUser() u: JwtUser) {
    return this.svc.map(intakeNo, b.po_no, u);
  }

  @Post(':intakeNo/post') @Permissions('creditors')
  post(@Param('intakeNo') intakeNo: string, @Body(new ZodValidationPipe(PostBody)) b: { po_no?: string; allow_duplicate?: boolean }, @CurrentUser() u: JwtUser) {
    return this.svc.post(intakeNo, b, u);
  }
}
