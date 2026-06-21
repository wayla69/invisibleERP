import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, PermissionsGuard } from './common/guards';
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
  ],
  providers: [
    // ทุก endpoint ต้อง auth (ยกเว้น @Public) แล้วจึงตรวจ @Permissions
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
