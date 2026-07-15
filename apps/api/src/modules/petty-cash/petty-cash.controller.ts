import { Controller, Get, Post, Param, Query, Body, HttpCode } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PettyCashService } from './petty-cash.service';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { EstablishFundBody, ReplenishBody, ExpenseRequestBody, SettleExpenseBody, RejectBody, type EstablishFundDto, type ReplenishDto, type ExpenseRequestDto, type SettleExpenseDto } from './dto';

// Petty cash float (วงเงิน) + direct-expense / advance maker-checker with document tracking (EXP-08).
// Maker raises a fund/request (creditors/exec); a DIFFERENT user approves (SoD enforced in the service).
@Controller('api/finance/petty-cash')
@Permissions('creditors', 'exec')
export class PettyCashController {
  constructor(private readonly svc: PettyCashService) {}

  @Post('funds') establishFund(@Body(new ZodValidationPipe(EstablishFundBody)) b: EstablishFundDto, @CurrentUser() u: JwtUser) { return this.svc.establishFund(b, u); }
  @Get('funds') listFunds(@CurrentUser() u: JwtUser) { return this.svc.listFunds(u); }
  @Post('funds/:fundCode/replenish') @HttpCode(200) replenish(@Param('fundCode') c: string, @Body(new ZodValidationPipe(ReplenishBody)) b: ReplenishDto, @CurrentUser() u: JwtUser) { return this.svc.replenishFund(c, b, u); }

  @Post('requests') createRequest(@Body(new ZodValidationPipe(ExpenseRequestBody)) b: ExpenseRequestDto, @CurrentUser() u: JwtUser) { return this.svc.createRequest(b, u); }
  @Get('requests') listRequests(@Query('status') status: string | undefined, @Query('fund_code') fundCode: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listRequests(u, { status, fund_code: fundCode }); }
  @Post('requests/:reqNo/approve') @HttpCode(200) approve(@Param('reqNo') r: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.approveRequest(r, u, b?.self_approval_reason); }
  @Post('requests/:reqNo/reject') @HttpCode(200) reject(@Param('reqNo') r: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectRequest(r, u, b?.reason); }
  @Post('requests/:reqNo/settle') @HttpCode(200) settle(@Param('reqNo') r: string, @Body(new ZodValidationPipe(SettleExpenseBody)) b: SettleExpenseDto, @CurrentUser() u: JwtUser) { return this.svc.settleRequest(r, b, u); }
}
