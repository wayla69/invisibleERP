import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ServiceService } from './service.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const ContractBody = z.object({ customer_name: z.string().min(1), sla_tier: z.string().optional(), start_date: z.string().min(1), end_date: z.string().min(1), monthly_value: z.number().nonnegative().optional() });
const EventBody = z.object({ title: z.string().min(1), priority: z.string().optional(), notes: z.string().optional(), opened_at: z.string().optional() });
const ResolveBody = z.object({ responded_at: z.string().optional(), resolved_at: z.string().optional(), notes: z.string().optional() });
const SubscriptionBody = z.object({ customer_name: z.string().min(1), product_code: z.string().min(1), description: z.string().optional(), billing_cycle: z.string().optional(), unit_price: z.number().nonnegative(), qty: z.number().positive().optional(), start_date: z.string().min(1) });
const RunBillingBody = z.object({ as_of_date: z.string().optional() });

@Controller('api/service')
export class ServiceController {
  constructor(private readonly svc: ServiceService) {}

  @Get('contracts')
  @Permissions('exec')
  listContracts(@CurrentUser() user: JwtUser) { return this.svc.listContracts(user); }

  @Post('contracts')
  @Permissions('masterdata')
  createContract(@Body(new ZodValidationPipe(ContractBody)) dto: z.infer<typeof ContractBody>, @CurrentUser() user: JwtUser) { return this.svc.createContract(dto, user); }

  @Get('contracts/:id/events')
  @Permissions('exec')
  listEvents(@Param('id', ParseIntPipe) id: number) { return this.svc.listEvents(id); }

  @Post('contracts/:id/events')
  @Permissions('exec')
  logEvent(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(EventBody)) dto: z.infer<typeof EventBody>, @CurrentUser() user: JwtUser) { return this.svc.logEvent(id, dto, user); }

  @Post('events/:id/resolve')
  @Permissions('exec')
  @HttpCode(200)
  resolveEvent(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ResolveBody)) dto: z.infer<typeof ResolveBody>, @CurrentUser() user: JwtUser) { return this.svc.resolveEvent(id, dto, user); }

  @Get('subscriptions')
  @Permissions('exec')
  listSubs(@CurrentUser() user: JwtUser) { return this.svc.listSubscriptions(user); }

  @Post('subscriptions')
  @Permissions('masterdata')
  createSub(@Body(new ZodValidationPipe(SubscriptionBody)) dto: z.infer<typeof SubscriptionBody>, @CurrentUser() user: JwtUser) { return this.svc.createSubscription(dto, user); }

  @Post('subscriptions/:id/pause')
  @Permissions('exec')
  @HttpCode(200)
  pause(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.updateSubscriptionStatus(id, 'Paused', user); }

  @Post('subscriptions/:id/resume')
  @Permissions('exec')
  @HttpCode(200)
  resume(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.updateSubscriptionStatus(id, 'Active', user); }

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
  runBilling(@Body(new ZodValidationPipe(RunBillingBody)) dto: z.infer<typeof RunBillingBody>, @CurrentUser() user: JwtUser) { return this.svc.runBilling(dto, user); }

  @Post('invoices/:id/pay')
  @Permissions('exec')
  @HttpCode(200)
  pay(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.payInvoice(id, user); }
}
