import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { SaasMetricsService } from './saas-metrics.service';
import { TenantController } from './tenant.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { PlanGuard } from './plan.guard';
import { PlatformNotificationsModule } from '../platform-notifications/platform-notifications.module';
import { MailerModule } from '../mailer/mailer.module';
import { BillingBiReports } from './billing-bi-reports';
import { StarterPackService } from './starter-pack.service';

// AuthModule exports PasswordService (signup hashes the admin password); LedgerModule exports
// LedgerService (signup provisions the new tenant's fiscal periods); TaxModule for cache invalidation.
// PlatformNotificationsModule exports the god event feed (BillingService emits onboarding/lifecycle events).
// PlanGuard is exported so AppModule can register it as APP_GUARD and so AdminUsersModule can
// inject BillingService for the user-limit check.
@Module({
  imports: [AuthModule, LedgerModule, TaxModule, PlatformNotificationsModule, MailerModule],
  controllers: [BillingController, TenantController, StripeWebhookController],
  providers: [BillingBiReports, BillingService, TenantLifecycleService, SaasMetricsService, PlanGuard, StarterPackService],
  exports: [BillingService, PlanGuard],
})
export class BillingModule {}
