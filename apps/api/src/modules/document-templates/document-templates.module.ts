import { Module } from '@nestjs/common';
import { DocumentTemplatesService } from './document-templates.service';
import { DocumentTemplatesController } from './document-templates.controller';

// Document templates (Platform Phase 10 — A3) — no-code, presentation-only customization of customer-facing
// documents (receipt live; tax invoices / quotations / POs / payslips to follow). Exports the service so the
// printing module can resolve a tenant's active template at render time. DRIZZLE is global.
@Module({
  controllers: [DocumentTemplatesController],
  providers: [DocumentTemplatesService],
  exports: [DocumentTemplatesService],
})
export class DocumentTemplatesModule {}
