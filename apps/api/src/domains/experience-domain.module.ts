import { Module } from '@nestjs/common';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { PortalModule } from '../modules/portal/portal.module';
import { MessagingModule } from '../modules/messaging/messaging.module';
import { PrintingModule } from '../modules/printing/printing.module';
import { PeripheralsModule } from '../modules/peripherals/peripherals.module';
import { ImagesModule } from '../modules/images/images.module';
import { DocumentTemplatesModule } from '../modules/document-templates/document-templates.module';

// docs/46 Phase 5 — communication & document surfaces (portal · notifications · messaging · printing · peripherals · images · document templates) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    NotificationsModule,
    PortalModule,
    MessagingModule,
    PrintingModule,
    PeripheralsModule,
    ImagesModule,
    DocumentTemplatesModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    NotificationsModule,
    PortalModule,
    MessagingModule,
    PrintingModule,
    PeripheralsModule,
    ImagesModule,
    DocumentTemplatesModule,
  ],
})
export class ExperienceDomainModule {}
