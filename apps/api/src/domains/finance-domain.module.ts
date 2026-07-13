import { Module } from '@nestjs/common';
import { FinanceModule } from '../modules/finance/finance.module';
import { LedgerModule } from '../modules/ledger/ledger.module';
import { TaxProvisionModule } from '../modules/tax-provision/tax-provision.module';
import { TreasuryDebtModule } from '../modules/treasury-debt/debt.module';
import { TreasuryInvestModule } from '../modules/treasury-invest/investment.module';
import { TreasuryHedgeModule } from '../modules/treasury-hedge/hedge.module';
import { TreasuryPoolModule } from '../modules/treasury-pool/pool.module';
import { DisclosureModule } from '../modules/disclosure/disclosure.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { TaxModule } from '../modules/tax/tax.module';
import { AssetsModule } from '../modules/assets/assets.module';
import { PettyCashModule } from '../modules/petty-cash/petty-cash.module';
import { EamModule } from '../modules/eam/eam.module';
import { LeasesModule } from '../modules/leases/leases.module';
import { BankModule } from '../modules/bank/bank.module';
import { BudgetModule } from '../modules/budget/budget.module';
import { RevenueModule } from '../modules/revenue/revenue.module';
import { RevBillingModule } from '../modules/revrec-billing/rev-billing.module';
import { RevVariableModule } from '../modules/revrec-variable/rev-variable.module';
import { RevModificationModule } from '../modules/revrec-modifications/rev-modification.module';
import { RevDisclosureModule } from '../modules/revrec-disclosure/rev-disclosure.module';
import { FxModule } from '../modules/fx/fx.module';
import { IntercompanyModule } from '../modules/intercompany/intercompany.module';
import { ConsolidationModule } from '../modules/consolidation/consolidation.module';
import { IcReconModule } from '../modules/ic-reconciliation/ic-recon.module';
import { ReconciliationModule } from '../modules/reconciliation/reconciliation.module';
import { ProfitabilityModule } from '../modules/profitability/profitability.module';
import { FluxModule } from '../modules/flux/flux.module';
import { EInvoiceModule } from '../modules/einvoice/einvoice.module';

// docs/46 Phase 5 — financial accounting & treasury (GL · AR/AP · tax · treasury · revrec · assets · leases · consolidation · reconciliation) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    FinanceModule,
    LedgerModule,
    TaxProvisionModule,
    TreasuryDebtModule,
    TreasuryInvestModule,
    TreasuryHedgeModule,
    TreasuryPoolModule,
    DisclosureModule,
    PaymentsModule,
    TaxModule,
    AssetsModule,
    PettyCashModule,
    EamModule,
    LeasesModule,
    BankModule,
    BudgetModule,
    RevenueModule,
    RevBillingModule,
    RevVariableModule,
    RevModificationModule,
    RevDisclosureModule,
    FxModule,
    IntercompanyModule,
    ConsolidationModule,
    IcReconModule,
    ReconciliationModule,
    ProfitabilityModule,
    FluxModule,
    EInvoiceModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    FinanceModule,
    LedgerModule,
    TaxProvisionModule,
    TreasuryDebtModule,
    TreasuryInvestModule,
    TreasuryHedgeModule,
    TreasuryPoolModule,
    DisclosureModule,
    PaymentsModule,
    TaxModule,
    AssetsModule,
    PettyCashModule,
    EamModule,
    LeasesModule,
    BankModule,
    BudgetModule,
    RevenueModule,
    RevBillingModule,
    RevVariableModule,
    RevModificationModule,
    RevDisclosureModule,
    FxModule,
    IntercompanyModule,
    ConsolidationModule,
    IcReconModule,
    ReconciliationModule,
    ProfitabilityModule,
    FluxModule,
    EInvoiceModule,
  ],
})
export class FinanceDomainModule {}
