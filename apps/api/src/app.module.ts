import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, PermissionsGuard } from './common/guards';
import { ModuleEnabledGuard } from './modules/admin-config/module.guard';
import { TenantTxInterceptor } from './common/tenant-tx.interceptor';
import { AuditInterceptor } from './common/audit.interceptor';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { PosModule } from './modules/pos/pos.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { FinanceModule } from './modules/finance/finance.module';
import { ReportsModule } from './modules/reports/reports.module';
import { CustomersModule } from './modules/customers/customers.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AiModule } from './modules/ai/ai.module';
import { PortalModule } from './modules/portal/portal.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { BomModule } from './modules/bom/bom.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TaxModule } from './modules/tax/tax.module';
import { BillingModule } from './modules/billing/billing.module';
import { PlatformModule } from './modules/platform/platform.module';
import { TaxDocsModule } from './modules/tax-docs/tax-docs.module';
import { RestaurantModule } from './modules/restaurant/restaurant.module';
import { AssetsModule } from './modules/assets/assets.module';
import { TaxReportsModule } from './modules/tax-reports/tax-reports.module';
import { MenuModule } from './modules/menu/menu.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { BankModule } from './modules/bank/bank.module';
import { BudgetModule } from './modules/budget/budget.module';
import { RevenueModule } from './modules/revenue/revenue.module';
import { FxModule } from './modules/fx/fx.module';
import { IntercompanyModule } from './modules/intercompany/intercompany.module';
import { GiftCardsModule } from './modules/giftcards/gift-card.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { MatchModule } from './modules/match/match.module';
import { SourcingModule } from './modules/sourcing/sourcing.module';
import { CostingModule } from './modules/costing/costing.module';
import { WmsModule } from './modules/wms/wms.module';
import { CrmModule } from './modules/crm/crm.module';
import { PlanningModule } from './modules/planning/planning.module';
import { ConsolidationModule } from './modules/consolidation/consolidation.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { ProfitabilityModule } from './modules/profitability/profitability.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { CpqModule } from './modules/cpq/cpq.module';
import { ServiceModule } from './modules/service/service.module';
import { BiModule } from './modules/bi/bi.module';
import { AdminConfigModule } from './modules/admin-config/admin-config.module';
import { MasterDataModule } from './modules/masterdata/masterdata.module';
import { StockOpsModule } from './modules/stock-ops/stock-ops.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { LotsModule } from './modules/lots/lots.module';
import { ScanModule } from './modules/scan/scan.module';
import { ImagesModule } from './modules/images/images.module';
import { AdminUsersModule } from './modules/admin-users/admin-users.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { ManufacturingModule } from './modules/manufacturing/manufacturing.module';
import { PosControlModule } from './modules/pos-control/pos-control.module';
import { PosTerminalModule } from './modules/pos-terminal/pos-terminal.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { PosAuditModule } from './modules/pos-audit/pos-audit.module';
import { PosFiscalModule } from './modules/pos-fiscal/pos-fiscal.module';
import { PosScaleModule } from './modules/pos-scale/pos-scale.module';
import { ChannelAdapterModule } from './modules/channel-adapter/channel-adapter.module';
import { PosLoyaltyLaborModule } from './modules/pos-loyalty-labor/pos-loyalty-labor.module';
import { ProjectsModule } from './modules/projects/projects.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    CommonModule,
    AuthModule, // exports JwtModule → JwtAuthGuard can inject JwtService
    HealthModule,
    InventoryModule,
    DashboardModule,
    PosModule,
    ProcurementModule,
    FinanceModule,
    ReportsModule,
    CustomersModule,
    NotificationsModule,
    AnalyticsModule,
    AiModule,
    PortalModule,
    MarketingModule,
    LoyaltyModule,
    BomModule,
    LedgerModule,
    PaymentsModule,
    TaxModule,
    BillingModule,
    PlatformModule,
    TaxDocsModule,
    RestaurantModule,
    AssetsModule,
    TaxReportsModule,
    MenuModule,
    ReturnsModule,
    BankModule,
    BudgetModule,
    RevenueModule,
    FxModule,
    IntercompanyModule,
    GiftCardsModule,
    WorkflowModule,
    MatchModule,
    SourcingModule,
    CostingModule,
    WmsModule,
    CrmModule,
    PlanningModule,
    ConsolidationModule,
    ReconciliationModule,
    ProfitabilityModule,
    PipelineModule,
    CpqModule,
    ServiceModule,
    BiModule,
    AdminConfigModule,
    MasterDataModule,
    StockOpsModule,
    ClaimsModule,
    DeliveryModule,
    LotsModule,
    ScanModule,
    ImagesModule,
    AdminUsersModule,
    PayrollModule,
    ManufacturingModule,
    PosControlModule,
    PosTerminalModule,
    PricingModule,
    PosAuditModule,
    PosFiscalModule,
    PosScaleModule,
    ChannelAdapterModule,
    PosLoyaltyLaborModule,
    ProjectsModule,
  ],
  providers: [
    // ทุก endpoint ต้อง auth (ยกเว้น @Public) แล้วจึงตรวจ @Permissions แล้วจึงตรวจ module on/off
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: ModuleEnabledGuard },
    // Audit (outermost — writes outside the tenant tx so failures are still recorded),
    // then TenantTx (inner — wraps the handler in an RLS-scoped transaction).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantTxInterceptor },
  ],
})
export class AppModule {}
