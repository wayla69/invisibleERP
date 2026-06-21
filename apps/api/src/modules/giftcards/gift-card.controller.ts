import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { GiftCardService } from './gift-card.service';
import { IssueGiftCardBody, type IssueGiftCardDto, RedeemGiftCardBody, type RedeemGiftCardDto } from './dto';

@Controller('api/pos/gift-cards')
export class GiftCardController {
  constructor(private readonly svc: GiftCardService) {}

  @Post('issue') @Permissions('pos')
  issue(@Body(new ZodValidationPipe(IssueGiftCardBody)) b: IssueGiftCardDto, @CurrentUser() u: JwtUser) { return this.svc.issue(b, u); }

  @Get(':card_no/balance') @Permissions('pos')
  balance(@Param('card_no') cardNo: string) { return this.svc.balance(cardNo); }

  // Standalone redeem against an open sale (primary redeem path is via checkout); applies the draw-down.
  @Post('redeem') @Permissions('pos')
  redeem(@Body(new ZodValidationPipe(RedeemGiftCardBody)) b: RedeemGiftCardDto, @CurrentUser() u: JwtUser) {
    return this.svc.redeemForSale(b.card_no, b.amount, b.sale_no, u.tenantId ?? null, u);
  }
}
