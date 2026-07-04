import { Controller, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DocAiService } from './doc-ai.service';

const ExtractBody = z.object({ text: z.string().min(1), doc_type: z.string().optional() });
const ExtractDocBody = z.object({ data_url: z.string().min(1).max(13_000_000), file_name: z.string().max(200).optional() });

// Document-AI intake (Phase 16 — B2). Extract-only AP-invoice draft from pasted text OR an uploaded
// image/PDF; a human reviews + posts through the normal AP flow. Never creates a bill or touches the GL.
@Controller('api/doc-ai')
export class DocAiController {
  constructor(private readonly svc: DocAiService) {}

  @Post('extract') @Permissions('procurement', 'creditors', 'exec')
  extract(@Body(new ZodValidationPipe(ExtractBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.extractInvoice(b.text, u); }

  // Extract from an uploaded bill photo/scan/PDF (base64 data: URL). Broadened to `pr_raise` so any staffer
  // can use it as the read-my-bill preview behind the Quick Capture lane (docs/34). Extract-only — no GL.
  @Post('extract-document') @Permissions('pr_raise', 'procurement', 'creditors', 'exec')
  extractDocument(@Body(new ZodValidationPipe(ExtractDocBody)) b: { data_url: string; file_name?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.extractFromDataUrl(b.data_url, u);
  }
}
