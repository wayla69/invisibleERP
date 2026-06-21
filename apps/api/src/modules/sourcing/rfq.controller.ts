import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RfqService } from './rfq.service';

const RfqBody = z.object({ required_date: z.string().optional(), remarks: z.string().optional(), items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), qty: z.number().positive(), uom: z.string().optional() })).min(1) });
const QuoteBody = z.object({ vendor_id: z.number().int().optional(), vendor_name: z.string().optional(), valid_until: z.string().optional(), lead_time_days: z.number().int().optional(), items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), qty: z.number().positive(), unit_price: z.number().nonnegative(), uom: z.string().optional() })).min(1) });
const AwardBody = z.object({ quote_no: z.string().min(1) });

@Controller('api/procurement/rfqs')
export class RfqController {
  constructor(private readonly svc: RfqService) {}

  @Post() @Permissions('procurement')
  create(@Body(new ZodValidationPipe(RfqBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createRfq(b, u); }
  @Get() @Permissions('procurement')
  list(@CurrentUser() u: JwtUser) { return this.svc.listRfqs(u); }
  @Get(':rfqNo') @Permissions('procurement')
  get(@Param('rfqNo') rfqNo: string, @CurrentUser() u: JwtUser) { return this.svc.getRfq(rfqNo, u); }
  @Post(':rfqNo/quotes') @Permissions('procurement')
  quote(@Param('rfqNo') rfqNo: string, @Body(new ZodValidationPipe(QuoteBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.submitQuote(rfqNo, b, u); }
  @Post(':rfqNo/award') @Permissions('procurement')
  award(@Param('rfqNo') rfqNo: string, @Body(new ZodValidationPipe(AwardBody)) b: { quote_no: string }, @CurrentUser() u: JwtUser) { return this.svc.award(rfqNo, b.quote_no, u); }
}
