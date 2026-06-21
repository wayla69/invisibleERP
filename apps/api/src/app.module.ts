import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, PermissionsGuard } from './common/guards';
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
  ],
  providers: [
    // ทุก endpoint ต้อง auth (ยกเว้น @Public) แล้วจึงตรวจ @Permissions
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Audit (outermost — writes outside the tenant tx so failures are still recorded),
    // then TenantTx (inner — wraps the handler in an RLS-scoped transaction).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantTxInterceptor },
  ],
})
export class AppModule {}
