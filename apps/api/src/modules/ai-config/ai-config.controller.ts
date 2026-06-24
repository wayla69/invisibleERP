import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AiConfigService } from './ai-config.service';

const SuggestBody = z.object({ target: z.string().min(1), description: z.string().min(1) });

// AI configuration assistant (Phase 18 — B4). Describe → proposed Studio config (review before applying).
@Controller('api/ai-config')
export class AiConfigController {
  constructor(private readonly svc: AiConfigService) {}

  @Get('targets') @Permissions('masterdata', 'users', 'exec')
  targets() { return this.svc.targets(); }

  @Post('suggest') @Permissions('masterdata', 'users', 'exec')
  suggest(@Body(new ZodValidationPipe(SuggestBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.suggest(b.target, b.description, u); }
}
