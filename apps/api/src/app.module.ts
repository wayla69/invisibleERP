import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './common/env.validation';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, PermissionsGuard, PlatformAdminGuard } from './common/guards';
import { ModuleEnabledGuard } from './modules/admin-config/module.guard';
import { PlanGuard } from './modules/billing/plan.guard';
import { TenantTxInterceptor } from './common/tenant-tx.interceptor';
import { AuditInterceptor } from './common/audit.interceptor';
import { JobsModule } from './modules/jobs/jobs.module';
import { PdfModule } from './modules/pdf/pdf.module';
import { MailModule } from './modules/mail/mail.module';
import { AuthModule } from './modules/auth/auth.module';
// docs/46 Phase 5 — the ~140 feature modules are grouped into ten domain AGGREGATES (src/domains/*),
// pure wiring modules that make ownership legible and keep a new feature module a one-line change in its
// own domain file instead of another line in a flat 140-entry array. Cosmetic for DI (Nest registers the
// transitive imports identically); infrastructure (@Global Jobs/Pdf/Mail, Database, Common, Config) and
// AuthModule (exports JwtModule → JwtAuthGuard can inject JwtService) stay at the root.
import { FinanceDomainModule } from './domains/finance-domain.module';
import { SupplyChainDomainModule } from './domains/supply-chain-domain.module';
import { SalesCrmDomainModule } from './domains/sales-crm-domain.module';
import { OperationsDomainModule } from './domains/operations-domain.module';
import { ProjectsDomainModule } from './domains/projects-domain.module';
import { PeopleDomainModule } from './domains/people-domain.module';
import { AnalyticsDomainModule } from './domains/analytics-domain.module';
import { AiDomainModule } from './domains/ai-domain.module';
import { ExperienceDomainModule } from './domains/experience-domain.module';
import { PlatformDomainModule } from './domains/platform-domain.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    CommonModule,
    JobsModule, // @Global async job queue + in-process worker (enqueue from any module)
    PdfModule, // @Global HTML→PDF renderer (external-service offload or pooled Chromium)
    MailModule, // @Global DocEmailService — email a rendered document (PDF attach, HTML fallback) via SMTP
    AuthModule, // exports JwtModule → JwtAuthGuard can inject JwtService
    FinanceDomainModule,
    SupplyChainDomainModule,
    SalesCrmDomainModule,
    OperationsDomainModule,
    ProjectsDomainModule,
    PeopleDomainModule,
    AnalyticsDomainModule,
    AiDomainModule,
    ExperienceDomainModule,
    PlatformDomainModule,
  ],
  providers: [
    // Guard order: auth → permission → module-enabled → plan-feature.
    // Each layer is narrower: PlanGuard only fires when the route carries @RequiresPlanFeature.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PlatformAdminGuard }, // after auth (needs req.user), before the tenant-tx interceptor
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
