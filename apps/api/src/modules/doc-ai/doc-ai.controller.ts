import { Controller, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DocAiService } from './doc-ai.service';

const ExtractBody = z.object({ text: z.string().min(1), doc_type: z.string().optional() });

// Document-AI intake (Phase 16 — B2). Extract-only AP-invoice draft from pasted text; human reviews + posts
// through the normal AP flow. Never creates a bill or touches the GL.
@Controller('api/doc-ai')
export class DocAiController {
  constructor(private readonly svc: DocAiService) {}

  @Post('extract') @Permissions('procurement', 'creditors', 'exec')
  extract(@Body(new ZodValidationPipe(ExtractBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.extractInvoice(b.text, u); }
}
