import { Module } from '@nestjs/common';
import { AuditViewerService } from './audit-viewer.service';
import { AuditViewerController } from './audit-viewer.controller';

// Phase 6 — read-only audit-trail viewer over the append-only audit_log. DRIZZLE is global.
@Module({
  controllers: [AuditViewerController],
  providers: [AuditViewerService],
  exports: [AuditViewerService],
})
export class AuditViewerModule {}
