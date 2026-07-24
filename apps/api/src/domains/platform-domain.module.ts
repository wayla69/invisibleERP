import { Module } from '@nestjs/common';
import { HealthModule } from '../modules/health/health.module';
import { BillingModule } from '../modules/billing/billing.module';
import { PlatformNotificationsModule } from '../modules/platform-notifications/platform-notifications.module';
import { MailerModule } from '../modules/mailer/mailer.module';
import { PlatformModule } from '../modules/platform/platform.module';
import { WorkflowModule } from '../modules/workflow/workflow.module';
import { CustomFieldsModule } from '../modules/custom-fields/custom-fields.module';
import { AlertsModule } from '../modules/alerts/alerts.module';
import { SavedViewsModule } from '../modules/saved-views/saved-views.module';
import { UserPrefsModule } from '../modules/user-prefs/user-prefs.module';
import { GeoRefModule } from '../modules/geo-ref/geo-ref.module';
import { FeatureFlagsModule } from '../modules/feature-flags/feature-flags.module';
import { ScheduledChangesModule } from '../modules/scheduled-changes/scheduled-changes.module';
import { AuditViewerModule } from '../modules/audit-viewer/audit-viewer.module';
import { AdminConfigModule } from '../modules/admin-config/admin-config.module';
import { AdminUsersModule } from '../modules/admin-users/admin-users.module';
import { SodRegisterModule } from '../modules/sod-register/sod-register.module';
import { CustomObjectsModule } from '../modules/custom-objects/custom-objects.module';
import { ObjectLayoutsModule } from '../modules/object-layouts/object-layouts.module';
import { PublicApiModule } from '../modules/public-api/public-api.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { ControlsModule } from '../modules/controls/controls.module';
import { ControlConsoleModule } from '../modules/control-console/control-console.module';
import { I18nModule } from '../modules/i18n/i18n.module';
import { ThemeModule } from '../modules/theme/theme.module';
import { OnboardingModule } from '../modules/onboarding/onboarding.module';
import { SearchModule } from '../modules/search/search.module';
import { DeveloperModule } from '../modules/developer/developer.module';
import { ConnectorsModule } from '../modules/connectors/connectors.module';
import { MigrationModule } from '../modules/migration/migration.module';
import { LocalizationModule } from '../modules/localization/localization.module';
import { OpsModule } from '../modules/ops/ops.module';
import { PdpaModule } from '../modules/pdpa/pdpa.module';
import { GovernanceModule } from '../modules/governance/governance.module';

// docs/46 Phase 5 — platform, governance & administration (health · billing/console · admin & identity · config/flags · workflow · controls · PDPA · ops · extensibility) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    HealthModule,
    BillingModule,
    PlatformNotificationsModule,
    MailerModule,
    PlatformModule,
    WorkflowModule,
    CustomFieldsModule,
    AlertsModule,
    SavedViewsModule,
    UserPrefsModule,
    GeoRefModule,
    FeatureFlagsModule,
    ScheduledChangesModule,
    AuditViewerModule,
    AdminConfigModule,
    AdminUsersModule,
    SodRegisterModule,
    CustomObjectsModule,
    ObjectLayoutsModule,
    PublicApiModule,
    IdentityModule,
    ControlsModule,
    ControlConsoleModule,
    I18nModule,
    ThemeModule,
    OnboardingModule,
    SearchModule,
    DeveloperModule,
    ConnectorsModule,
    MigrationModule,
    LocalizationModule,
    OpsModule,
    PdpaModule,
    GovernanceModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    HealthModule,
    BillingModule,
    PlatformNotificationsModule,
    MailerModule,
    PlatformModule,
    WorkflowModule,
    CustomFieldsModule,
    AlertsModule,
    SavedViewsModule,
    UserPrefsModule,
    GeoRefModule,
    FeatureFlagsModule,
    ScheduledChangesModule,
    AuditViewerModule,
    AdminConfigModule,
    AdminUsersModule,
    SodRegisterModule,
    CustomObjectsModule,
    ObjectLayoutsModule,
    PublicApiModule,
    IdentityModule,
    ControlsModule,
    ControlConsoleModule,
    I18nModule,
    ThemeModule,
    OnboardingModule,
    SearchModule,
    DeveloperModule,
    ConnectorsModule,
    MigrationModule,
    LocalizationModule,
    OpsModule,
    PdpaModule,
    GovernanceModule,
  ],
})
export class PlatformDomainModule {}
