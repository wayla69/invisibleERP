import { Module } from '@nestjs/common';
import { AuditViewerService } from './audit-viewer.service';
import { AuditViewerController } from './audit-viewer.controller';
import { PdpaModule } from '../pdpa/pdpa.module';

// Phase 6 — read-only audit-trail viewer over the append-only audit_log. DRIZZLE is global.
// Imports PdpaModule so PdpaService can pseudonymise erased data subjects at read-time (PDPA).
@Module({
  imports: [PdpaModule],
  controllers: [AuditViewerController],
  providers: [AuditViewerService],
  exports: [AuditViewerService],
})
export class AuditViewerModule {}
