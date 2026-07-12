import { Controller, Get, Post, Patch, Body, Param, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ServiceKbService } from './service-kb.service';

const CreateBody = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(200_000),
  category: z.string().max(120).optional(),
  tags: z.string().max(500).optional(),
});
const UpdateBody = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(200_000).optional(),
  category: z.string().max(120).optional(),
  tags: z.string().max(500).optional(),
});
const FeedbackBody = z.object({ helpful: z.boolean() });
const DeflectBody = z.object({
  query: z.string().max(500).optional(),
  article_id: z.number().int().positive().optional(),
  deflected: z.boolean(),
  case_id: z.number().int().positive().optional(),
});

// SVC-6 — Knowledge Base + Case Deflection. Authoring + self-service search for the service team (coarse
// exec/marketing duties, mirroring the /service surface). The SVC-06 maker-checker (publisher ≠ author) is
// enforced in the service, not by a distinct permission.
@Controller('api/service/kb')
@Permissions('exec', 'marketing')
export class ServiceKbController {
  constructor(private readonly svc: ServiceKbService) {}

  @Get('articles') list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listArticles(u, status); }
  @Get('search') search(@Query('q') q: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.search(u, q ?? ''); }
  @Get('deflection-stats') stats(@CurrentUser() u: JwtUser) { return this.svc.deflectionStats(u); }
  @Get('articles/:id') get(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.getArticle(u, +id); }
  @Post('articles') @HttpCode(201) create(@Body(new ZodValidationPipe(CreateBody)) b: z.infer<typeof CreateBody>, @CurrentUser() u: JwtUser) { return this.svc.createArticle(u, b); }
  @Patch('articles/:id') update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateBody)) b: z.infer<typeof UpdateBody>, @CurrentUser() u: JwtUser) { return this.svc.updateArticle(u, +id, b); }
  @Post('articles/:id/publish') @HttpCode(200) publish(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.publishArticle(u, +id); }
  @Post('articles/:id/archive') @HttpCode(200) archive(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.archiveArticle(u, +id); }
  @Post('articles/:id/feedback') @HttpCode(200) feedback(@Param('id') id: string, @Body(new ZodValidationPipe(FeedbackBody)) b: { helpful: boolean }, @CurrentUser() u: JwtUser) { return this.svc.feedback(u, +id, b); }
  @Post('deflect') @HttpCode(201) deflect(@Body(new ZodValidationPipe(DeflectBody)) b: z.infer<typeof DeflectBody>, @CurrentUser() u: JwtUser) { return this.svc.logDeflection(u, b); }
}
