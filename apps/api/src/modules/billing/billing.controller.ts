import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Public, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { BillingService, type SignupDto } from './billing.service';

const SignupBody = z.object({
  company_name: z.string().min(1),
  tenant_code: z.string().min(1),
  admin_username: z.string().min(1),
  admin_password: z.string().min(8),
  email: z.string().email(),
  plan_code: z.string().optional(),
});

const CheckoutBody = z.object({ plan_code: z.string().min(1) });
const ChangePlanBody = z.object({ plan_code: z.string().min(1) });

@Controller('api')
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  // PUBLIC self-serve signup — provisions tenant + admin user + trialing subscription
  @Post('auth/signup') @Public()
  signup(@Body(new ZodValidationPipe(SignupBody)) b: SignupDto) {
    return this.svc.signup(b);
  }

  // PUBLIC plan catalogue
  @Get('billing/plans') @Public()
  plans() {
    return this.svc.listPlans();
  }

  @Get('billing/subscription') @Permissions('users')
  async subscription(@CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.getSubscription(tenantId);
  }

  @Post('billing/checkout') @Permissions('users')
  async checkout(@Body(new ZodValidationPipe(CheckoutBody)) b: { plan_code: string }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.createCheckoutSession(tenantId, b.plan_code);
  }

  @Post('billing/change-plan') @Permissions('users')
  async changePlan(@Body(new ZodValidationPipe(ChangePlanBody)) b: { plan_code: string }, @CurrentUser() u: JwtUser) {
    const tenantId = await this.svc.resolveTenantId(u);
    return this.svc.changePlan(tenantId, b.plan_code);
  }
}
