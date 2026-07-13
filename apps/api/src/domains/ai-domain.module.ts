import { Module } from '@nestjs/common';
import { AiModule } from '../modules/ai/ai.module';
import { AutomationModule } from '../modules/automation/automation.module';
import { QueryModule } from '../modules/query/query.module';
import { CopilotModule } from '../modules/copilot/copilot.module';
import { DocAiModule } from '../modules/doc-ai/doc-ai.module';
import { ApIntakeModule } from '../modules/ap-intake/ap-intake.module';
import { EmailCaptureModule } from '../modules/email-capture/email-capture.module';
import { NlAnalyticsModule } from '../modules/nl-analytics/nl-analytics.module';
import { AiConfigModule } from '../modules/ai-config/ai-config.module';

// docs/46 Phase 5 — AI & intelligent capture (assistant · copilot · doc-AI · AP intake · email capture · NL analytics · automation) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    AiModule,
    AutomationModule,
    QueryModule,
    CopilotModule,
    DocAiModule,
    ApIntakeModule,
    EmailCaptureModule,
    NlAnalyticsModule,
    AiConfigModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    AiModule,
    AutomationModule,
    QueryModule,
    CopilotModule,
    DocAiModule,
    ApIntakeModule,
    EmailCaptureModule,
    NlAnalyticsModule,
    AiConfigModule,
  ],
})
export class AiDomainModule {}
