import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReturnsService } from './returns.service';
import { CreateReturnBody, type CreateReturnDto } from './dto';

// คืนสินค้า/คืนเงิน — item-level POS returns: refund + restock + GL reversal.
@Controller('api/pos/returns')
@Permissions('returns', 'pos')
export class ReturnsController {
  constructor(private readonly svc: ReturnsService) {}

  @Post()
  create(@Body(new ZodValidationPipe(CreateReturnBody)) b: CreateReturnDto, @CurrentUser() u: JwtUser) { return this.svc.createReturn(b, u); }

  @Get(':return_no')
  get(@Param('return_no') no: string, @CurrentUser() u: JwtUser) { return this.svc.getReturn(no, u); }

  @Get()
  list(@Query('sale_no') saleNo: string, @CurrentUser() u: JwtUser) { return this.svc.listReturnsForSale(saleNo, u); }
}
