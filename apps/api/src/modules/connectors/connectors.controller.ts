import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ConnectorsService } from './connectors.service';

const RegisterBody = z.object({ type: z.string().min(1), label: z.string().optional(), config: z.any().optional() });

// D2 (Phase 24) — connector framework. Register + sync (stub transport, idempotent); never auto-posts.
@Controller('api/connectors')
export class ConnectorsController {
  constructor(private readonly svc: ConnectorsService) {}

  @Get('catalog') @Permissions('users', 'exec') catalog() { return this.svc.catalog(); }

  @Get() @Permissions('users', 'exec') list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }

  @Post() @Permissions('users', 'exec')
  register(@Body(new ZodValidationPipe(RegisterBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.register(u, b.type, b.label, b.config); }

  @Post(':id/sync') @Permissions('users', 'exec')
  sync(@Param('id') id: string, @Body() body: any, @CurrentUser() u: JwtUser) { return this.svc.sync(u, +id, body ?? {}); }

  @Get(':id/syncs') @Permissions('users', 'exec')
  syncs(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.syncs(u, +id); }
}
