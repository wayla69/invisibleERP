import { Controller, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CopilotService } from './copilot.service';

const AskBody = z.object({ question: z.string().min(1), context: z.string().optional() });

// Embedded copilot (Phase 15 — B1). Context-aware, KB-grounded Q&A; read-only, never posts to the GL.
@Controller('api/copilot')
export class CopilotController {
  constructor(private readonly svc: CopilotService) {}

  @Post('ask') @Permissions('ai_chat', 'dashboard')
  ask(@Body(new ZodValidationPipe(AskBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.ask(b.question, b.context, u); }
}
