import { Global, Module } from '@nestjs/common';
import { PdfRenderer } from './pdf-renderer.service';

// @Global so the (four) PDF-producing services can inject the shared renderer without each module
// re-importing it. Centralises HTML→PDF: external-service offload (PDF_SERVICE_URL) or pooled Chromium.
@Global()
@Module({
  providers: [PdfRenderer],
  exports: [PdfRenderer],
})
export class PdfModule {}
