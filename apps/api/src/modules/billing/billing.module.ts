import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { SaasMetricsService } from './saas-metrics.service';
import { TenantController } from './tenant.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { PlanGuard } from './plan.guard';

// AuthModule exports PasswordService (signup hashes the admin password); LedgerModule exports
// LedgerService (signup provisions the new tenant's fiscal periods); TaxModule for cache invalidation.
// PlanGuard is exported so AppModule can register it as APP_GUARD and so AdminUsersModule can
// inject BillingService for the user-limit check.
@Module({
  imports: [AuthModule, LedgerModule, TaxModule],
  controllers: [BillingController, TenantController, StripeWebhookController],
  providers: [BillingService, SaasMetricsService, PlanGuard],
  exports: [BillingService, PlanGuard],
})
export class BillingModule {}
