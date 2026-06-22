import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpCode } from '@nestjs/common';
import { ServiceService } from './service.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

@Controller('api/service')
export class ServiceController {
  constructor(private readonly svc: ServiceService) {}

  @Get('contracts')
  @Permissions('exec')
  listContracts(@CurrentUser() user: JwtUser) { return this.svc.listContracts(user); }

  @Post('contracts')
  @Permissions('masterdata')
  createContract(@Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.createContract(dto, user); }

  @Get('contracts/:id/events')
  @Permissions('exec')
  listEvents(@Param('id', ParseIntPipe) id: number) { return this.svc.listEvents(id); }

  @Post('contracts/:id/events')
  @Permissions('exec')
  logEvent(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.logEvent(id, dto, user); }

  @Post('events/:id/resolve')
  @Permissions('exec')
  @HttpCode(200)
  resolveEvent(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.resolveEvent(id, dto, user); }

  @Get('subscriptions')
  @Permissions('exec')
  listSubs(@CurrentUser() user: JwtUser) { return this.svc.listSubscriptions(user); }

  @Post('subscriptions')
  @Permissions('masterdata')
  createSub(@Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.createSubscription(dto, user); }

  @Post('subscriptions/:id/pause')
  @Permissions('exec')
  @HttpCode(200)
  pause(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.updateSubscriptionStatus(id, 'Paused', user); }

  @Post('subscriptions/:id/cancel')
  @Permissions('exec')
  @HttpCode(200)
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.updateSubscriptionStatus(id, 'Cancelled', user); }

  @Get('subscriptions/:id/invoices')
  @Permissions('exec')
  listInvoices(@Param('id', ParseIntPipe) id: number) { return this.svc.listInvoices(id); }

  @Post('billing/run')
  @Permissions('approvals')
  @HttpCode(200)
  runBilling(@Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.runBilling(dto, user); }

  @Post('invoices/:id/pay')
  @Permissions('exec')
  @HttpCode(200)
  pay(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.payInvoice(id, user); }
}
