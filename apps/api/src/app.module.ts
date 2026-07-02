import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './common/env.validation';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, PermissionsGuard } from './common/guards';
import { ModuleEnabledGuard } from './modules/admin-config/module.guard';
import { PlanGuard } from './modules/billing/plan.guard';
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
import { CrmPipelineModule } from './modules/crm-pipeline/crm-pipeline.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AiModule } from './modules/ai/ai.module';
import { PortalModule } from './modules/portal/portal.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { GamificationModule } from './modules/gamification/gamification.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { WheelsModule } from './modules/wheels/wheels.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { JourneysModule } from './modules/journeys/journeys.module';
import { PartnersModule } from './modules/partners/partners.module';
import { LoyaltyAnalyticsModule } from './modules/loyalty-analytics/loyalty-analytics.module';
import { MemberModule } from './modules/member/member.module';
import { BomModule } from './modules/bom/bom.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TaxModule } from './modules/tax/tax.module';
import { BillingModule } from './modules/billing/billing.module';
import { PlatformModule } from './modules/platform/platform.module';
import { RestaurantModule } from './modules/restaurant/restaurant.module';
import { AssetsModule } from './modules/assets/assets.module';
import { PettyCashModule } from './modules/petty-cash/petty-cash.module';
import { EamModule } from './modules/eam/eam.module';
import { LeasesModule } from './modules/leases/leases.module';
import { MenuModule } from './modules/menu/menu.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { BankModule } from './modules/bank/bank.module';
import { BudgetModule } from './modules/budget/budget.module';
import { RevenueModule } from './modules/revenue/revenue.module';
import { FxModule } from './modules/fx/fx.module';
import { IntercompanyModule } from './modules/intercompany/intercompany.module';
import { CoalitionModule } from './modules/coalition/coalition.module';
import { NpsModule } from './modules/nps/nps.module';
import { GiftCardsModule } from './modules/giftcards/gift-card.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { MatchModule } from './modules/match/match.module';
import { SourcingModule } from './modules/sourcing/sourcing.module';
import { CostingModule } from './modules/costing/costing.module';
import { WmsModule } from './modules/wms/wms.module';
import { CrmModule } from './modules/crm/crm.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { PrintingModule } from './modules/printing/printing.module';
import { PeripheralsModule } from './modules/peripherals/peripherals.module';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { SavedViewsModule } from './modules/saved-views/saved-views.module';
import { UserPrefsModule } from './modules/user-prefs/user-prefs.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { AuditViewerModule } from './modules/audit-viewer/audit-viewer.module';
import { PlanningModule } from './modules/planning/planning.module';
import { ConsolidationModule } from './modules/consolidation/consolidation.module';
import { IcReconModule } from './modules/ic-reconciliation/ic-recon.module';
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
import { ProjectsModule } from './modules/projects/projects.module';
import { MfgDepthModule } from './modules/mfg-depth/mfg-depth.module';
import { HcmModule } from './modules/hcm/hcm.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { PosAuditModule } from './modules/pos-audit/pos-audit.module';
import { PosFiscalModule } from './modules/pos-fiscal/pos-fiscal.module';
import { PosScaleModule } from './modules/pos-scale/pos-scale.module';
import { ChannelAdapterModule } from './modules/channel-adapter/channel-adapter.module';
import { PosLoyaltyLaborModule } from './modules/pos-loyalty-labor/pos-loyalty-labor.module';
import { BranchModule } from './modules/branch/branch.module';
import { EssModule } from './modules/ess/ess.module';
import { SupplierModule } from './modules/supplier/supplier.module';
import { DemandMlModule } from './modules/demand-ml/demand-ml.module';
import { AutomationModule } from './modules/automation/automation.module';
import { QueryModule } from './modules/query/query.module';
import { CopilotModule } from './modules/copilot/copilot.module';
import { DocAiModule } from './modules/doc-ai/doc-ai.module';
import { NlAnalyticsModule } from './modules/nl-analytics/nl-analytics.module';
import { AiConfigModule } from './modules/ai-config/ai-config.module';
import { ControlsModule } from './modules/controls/controls.module';
import { DocumentTemplatesModule } from './modules/document-templates/document-templates.module';
import { CustomObjectsModule } from './modules/custom-objects/custom-objects.module';
import { ObjectLayoutsModule } from './modules/object-layouts/object-layouts.module';
import { PublicApiModule } from './modules/public-api/public-api.module';
import { IdentityModule } from './modules/identity/identity.module';
import { I18nModule } from './modules/i18n/i18n.module';
import { ThemeModule } from './modules/theme/theme.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { DeveloperModule } from './modules/developer/developer.module';
import { ConnectorsModule } from './modules/connectors/connectors.module';
import { MigrationModule } from './modules/migration/migration.module';
import { LocalizationModule } from './modules/localization/localization.module';
import { EInvoiceModule } from './modules/einvoice/einvoice.module';
import { OpsModule } from './modules/ops/ops.module';
import { PdpaModule } from './modules/pdpa/pdpa.module';
import { GovernanceModule } from './modules/governance/governance.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { PdfModule } from './modules/pdf/pdf.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    CommonModule,
    JobsModule, // @Global async job queue + in-process worker (enqueue from any module)
    PdfModule, // @Global HTML→PDF renderer (external-service offload or pooled Chromium)
    AuthModule, // exports JwtModule → JwtAuthGuard can inject JwtService
    HealthModule,
    InventoryModule,
    DashboardModule,
    PosModule,
    ProcurementModule,
    FinanceModule,
    ReportsModule,
    CustomersModule,
    CrmPipelineModule,
    NotificationsModule,
    AnalyticsModule,
    AiModule,
    PortalModule,
    MarketingModule,
    LoyaltyModule,
    RewardsModule,
    GamificationModule,
    ReferralsModule,
    WheelsModule,
    CampaignsModule,
    JourneysModule,
    PartnersModule,
    LoyaltyAnalyticsModule,
    MemberModule,
    BomModule,
    LedgerModule,
    PaymentsModule,
    TaxModule,
    BillingModule,
    PlatformModule,
    RestaurantModule,
    AssetsModule,
    PettyCashModule,
    EamModule,
    LeasesModule,
    MenuModule,
    ReturnsModule,
    BankModule,
    BudgetModule,
    RevenueModule,
    FxModule,
    IntercompanyModule,
    CoalitionModule,
    NpsModule,
    GiftCardsModule,
    WorkflowModule,
    MatchModule,
    SourcingModule,
    CostingModule,
    WmsModule,
    CrmModule,
    MessagingModule,
    PrintingModule,
    PeripheralsModule,
    CustomFieldsModule,
    AlertsModule,
    SavedViewsModule,
    UserPrefsModule,
    FeatureFlagsModule,
    AuditViewerModule,
    PlanningModule,
    ConsolidationModule,
    IcReconModule,
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
    ProjectsModule,
    MfgDepthModule,
    HcmModule,
    PricingModule,
    PosAuditModule,
    PosFiscalModule,
    PosScaleModule,
    ChannelAdapterModule,
    PosLoyaltyLaborModule,
    BranchModule,
    EssModule,
    SupplierModule,
    DemandMlModule,
    DocumentTemplatesModule,
    CustomObjectsModule,
    ObjectLayoutsModule,
    PublicApiModule,
    IdentityModule,
    AutomationModule,
    QueryModule,
    CopilotModule,
    DocAiModule,
    NlAnalyticsModule,
    AiConfigModule,
    ControlsModule,
    I18nModule,
    ThemeModule,
    OnboardingModule,
    DeveloperModule,
    ConnectorsModule,
    MigrationModule,
    LocalizationModule,
    EInvoiceModule,
    OpsModule,
    PdpaModule,
    GovernanceModule,
  ],
  providers: [
    // Guard order: auth → permission → module-enabled → plan-feature.
    // Each layer is narrower: PlanGuard only fires when the route carries @RequiresPlanFeature.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: ModuleEnabledGuard },
    { provide: APP_GUARD, useClass: PlanGuard },
    // Audit (outermost — writes outside the tenant tx so failures are still recorded),
    // then TenantTx (inner — wraps the handler in an RLS-scoped transaction).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantTxInterceptor },
  ],
})
export class AppModule {}
