import { Controller, Post, Param, Body } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SplitBillService } from './split.service';
import { MultiTenderBody, SplitPreviewBody, SplitSettleBody, type MultiTenderDto, type SplitPreviewDto, type SplitSettleDto } from './split.dto';

// แยกบิล / แยกจ่าย — split a dine-in bill into N checks (each its own sale+GL+invoice) or pay one bill with N tenders.
@Controller('api/pos')
@Permissions('pos', 'order_mgt')
export class SplitController {
  constructor(private readonly split: SplitBillService) {}

  @Post('orders/:orderNo/pay-multi')
  payMulti(@Param('orderNo') o: string, @Body(new ZodValidationPipe(MultiTenderBody)) b: MultiTenderDto, @CurrentUser() u: JwtUser) { return this.split.payMulti(o, b, u); }

  @Post('orders/:orderNo/finalize')
  finalize(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.split.finalize(o, u); }

  @Post('orders/:orderNo/split/preview')
  preview(@Param('orderNo') o: string, @Body(new ZodValidationPipe(SplitPreviewBody)) b: SplitPreviewDto, @CurrentUser() u: JwtUser) { return this.split.previewSplit(o, b, u); }

  @Post('orders/:orderNo/split/settle')
  settle(@Param('orderNo') o: string, @Body(new ZodValidationPipe(SplitSettleBody)) b: SplitSettleDto, @CurrentUser() u: JwtUser) { return this.split.settleSplit(o, b, u); }
}
