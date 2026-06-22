import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { TenantController } from './tenant.controller';

// AuthModule exports PasswordService (signup hashes the admin password); LedgerModule exports
// LedgerService (signup provisions the new tenant's fiscal periods); TaxModule for cache invalidation.
@Module({
  imports: [AuthModule, LedgerModule, TaxModule],
  controllers: [BillingController, TenantController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
