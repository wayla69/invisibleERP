import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { GiftCardService } from './gift-card.service';
import { IssueGiftCardBody, type IssueGiftCardDto, RedeemGiftCardBody, type RedeemGiftCardDto } from './dto';
import { qint } from '../../common/query';

@Controller('api/pos/gift-cards')
export class GiftCardController {
  constructor(private readonly svc: GiftCardService) {}

  @Post('issue') @Permissions('pos')
  issue(@Body(new ZodValidationPipe(IssueGiftCardBody)) b: IssueGiftCardDto, @CurrentUser() u: JwtUser) { return this.svc.issue(b, u); }

  // Gift-card register — all cards + outstanding (Active-balance) liability. Visible to POS + finance.
  @Get() @Permissions('pos', 'creditors', 'exec')
  list(@CurrentUser() u: JwtUser, @Query('status') status?: string, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.listCards({ status, search, limit: qint('limit', limit, 200) }, u);
  }

  @Get(':card_no/txns') @Permissions('pos', 'creditors', 'exec')
  txns(@Param('card_no') cardNo: string) { return this.svc.cardTxns(cardNo); }

  @Get(':card_no/balance') @Permissions('pos')
  balance(@Param('card_no') cardNo: string) { return this.svc.balance(cardNo); }

  // Standalone redeem against an open sale (primary redeem path is via checkout); applies the draw-down.
  @Post('redeem') @Permissions('pos')
  redeem(@Body(new ZodValidationPipe(RedeemGiftCardBody)) b: RedeemGiftCardDto, @CurrentUser() u: JwtUser) {
    return this.svc.redeemForSale(b.card_no, b.amount, b.sale_no, u.tenantId ?? null, u);
  }
}
